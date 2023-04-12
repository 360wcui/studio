// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Immutable as Im } from "immer";
import { assignWith, last, isEmpty } from "lodash";
import memoizeWeak from "memoize-weak";

import { filterMap } from "@foxglove/den/collection";
import { Time, isLessThan, isGreaterThan, compare as compareTimes } from "@foxglove/rostime";
import { MessageBlock } from "@foxglove/studio-base/PanelAPI/useBlocksByTopic";
import { MessageDataItemsByPath } from "@foxglove/studio-base/components/MessagePathSyntax/useCachedGetMessagePathDataItems";
import { PlotDataByPath, PlotDataItem } from "@foxglove/studio-base/panels/Plot/internalTypes";
import { getTimestampForMessage } from "@foxglove/studio-base/util/time";

const MAX_TIME = Object.freeze({ sec: Infinity, nsec: Infinity });
const MIN_TIME = Object.freeze({ sec: -Infinity, nsec: -Infinity });

function minTime(a: Time, b: Time): Time {
  return isLessThan(a, b) ? a : b;
}

function maxTime(a: Time, b: Time): Time {
  return isLessThan(a, b) ? b : a;
}

/**
 * Find the earliest and latest times of messages in data.
 */
export const findTimeRange = memoizeWeak((data: Im<PlotDataByPath>): { start: Time; end: Time } => {
  let start: Time = MAX_TIME;
  let end: Time = MIN_TIME;
  for (const path of Object.keys(data)) {
    for (const item of data[path] ?? []) {
      for (const datum of item) {
        start = minTime(start, datum.receiveTime);
        end = maxTime(end, datum.receiveTime);
      }
    }
  }

  return { start, end };
});

/**
 * Fetch the data we need from each item in itemsByPath and discard the rest of
 * the message to save memory.
 */
const getByPath = (itemsByPath: MessageDataItemsByPath): PlotDataByPath => {
  const ret: PlotDataByPath = {};
  Object.entries(itemsByPath).forEach(([path, items]) => {
    ret[path] = [
      items.map((messageAndData) => {
        const headerStamp = getTimestampForMessage(messageAndData.messageEvent.message);
        return {
          queriedData: messageAndData.queriedData,
          receiveTime: messageAndData.messageEvent.receiveTime,
          headerStamp,
        };
      }),
    ];
  });
  return ret;
};

const getMessagePathItemsForBlock = memoizeWeak(
  (
    decodeMessagePathsForMessagesByTopic: (_: MessageBlock) => MessageDataItemsByPath,
    block: MessageBlock,
  ): PlotDataByPath => {
    return Object.freeze(getByPath(decodeMessagePathsForMessagesByTopic(block)));
  },
);

/**
 * Fetch all the plot data we want for our current subscribed topics from blocks.
 */
export function getBlockItemsByPath(
  decodeMessagePathsForMessagesByTopic: (_: MessageBlock) => MessageDataItemsByPath,
  blocks: readonly MessageBlock[],
): PlotDataByPath {
  const ret: PlotDataByPath = {};
  const lastBlockIndexForPath: Record<string, number> = {};
  let count = 0;
  let i = 0;
  for (const block of blocks) {
    const messagePathItemsForBlock: PlotDataByPath = getMessagePathItemsForBlock(
      decodeMessagePathsForMessagesByTopic,
      block,
    );

    // After 1 million data points we check if there is more memory to continue loading more
    // data points. This helps prevent runaway memory use if the user tried to plot a binary topic.
    //
    // An example would be to try plotting `/map.data[:]` where map is an occupancy grid
    // this can easily result in many millions of points.
    if (count >= 1_000_000) {
      // if we have memory stats we can let the user have more points as long as memory is not under pressure
      if (performance.memory) {
        const pct = performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit;
        if (isNaN(pct) || pct > 0.6) {
          return ret;
        }
      } else {
        return ret;
      }
    }

    for (const [path, messagePathItems] of Object.entries(messagePathItemsForBlock)) {
      count += messagePathItems[0]?.[0]?.queriedData.length ?? 0;

      const existingItems = ret[path] ?? [];
      // getMessagePathItemsForBlock returns an array of exactly one range of items.
      const [pathItems] = messagePathItems;
      if (lastBlockIndexForPath[path] === i - 1) {
        // If we are continuing directly from the previous block index (i - 1) then add to the
        // existing range, otherwise start a new range
        const currentRange = existingItems[existingItems.length - 1];
        if (currentRange && pathItems) {
          for (const item of pathItems) {
            currentRange.push(item);
          }
        }
      } else {
        if (pathItems) {
          // Start a new contiguous range. Make a copy so we can extend it.
          existingItems.push(pathItems.slice());
        }
      }
      ret[path] = existingItems;
      lastBlockIndexForPath[path] = i;
    }

    i += 1;
  }
  return ret;
}

/**
 * Merge two PlotDataByPath objects into a single PlotDataByPath object,
 * discarding any overlapping messages between the two items.
 */
function mergeByPath(a: Im<PlotDataByPath>, b: Im<PlotDataByPath>): Im<PlotDataByPath> {
  return assignWith(
    {},
    a,
    b,
    (objValue: undefined | PlotDataItem[][], srcValue: undefined | PlotDataItem[][]) => {
      if (objValue == undefined) {
        return srcValue;
      }
      const lastTime = last(last(objValue))?.receiveTime ?? MIN_TIME;
      const newValues = filterMap(srcValue ?? [], (item) => {
        const laterDatums = item.filter((datum) => isGreaterThan(datum.receiveTime, lastTime));
        return laterDatums.length > 0 ? laterDatums : undefined;
      });
      return newValues.length > 0 ? objValue.concat(newValues) : objValue;
    },
  );
}

// Order plot data first by earliest start time, then by latest end time since
// our first element when combining will be coming from blocks is likely to
// overlap more than individual playback segments.
function compare(a: Im<PlotDataByPath>, b: Im<PlotDataByPath>): number {
  const rangeA = findTimeRange(a);
  const rangeB = findTimeRange(b);
  const startCompare = compareTimes(rangeA.start, rangeB.start);
  if (startCompare !== 0) {
    return startCompare;
  }
  return compareTimes(rangeB.end, rangeA.end);
}

/**
 * Reduce multiple PlotDataByPath objects into a single PlotDataByPath object,
 * concatenating messages for each path after trimming messages that overlap
 * between items.
 */
export function combine(data: Im<PlotDataByPath[]>): Im<PlotDataByPath> {
  const sorted = data.slice().sort(compare);

  const reduced = sorted.reduce((acc, item) => {
    if (isEmpty(acc)) {
      return item;
    }
    return mergeByPath(acc, item);
  }, {} as PlotDataByPath);

  return reduced;
}
