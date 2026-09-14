import { z } from 'zod';
import { problem } from '@tether/core';

/**
 * The wire shape of one screen's answers, and the translation to rows.
 *
 * The shape is not this service's invention: it is `TetherSession._encodeAnswers`
 * in the Flutter app, which both `toJson()` and `exportRecord()` emit —
 *
 *     {"chips": {"0": [1,3]}, "option": {"1": 2}, "slider": {}, "text": {}}
 *
 * — four maps of *block index* to value. The app keeps them as one object per
 * screen because the two audiences never see each other's copy, and the same
 * reasoning applies here: if the backend invented a fifth shape, the app's
 * snapshot, the app's export and the server's export would be three formats
 * describing one thing.
 *
 * `record.screen_answer` stores this transposed — one row per block, with
 * `kind` naming which of the four maps it came from and `value` holding the
 * payload as jsonb. That is the schema's choice and a good one: four nullable
 * columns would have no way to say which is meant.
 */

/**
 * Block indices arrive as JSON object keys and are therefore strings.
 *
 * The app's own `_readBlocks` carries a comment about this being "the detail
 * that silently drops every answer if it is missed". Rejecting a non-numeric
 * key rather than skipping it is the server-side version of not missing it.
 */
const blockKeyed = <T extends z.ZodTypeAny>(value: T) =>
  z.record(
    z.string().regex(/^(0|[1-9]\d*)$/, 'must be a block index'),
    value,
  );

/**
 * `.strict()` so an unknown fifth map is a 400 rather than silent data loss.
 * A client that grows a new block kind should learn that this service has not.
 */
export const encodedScreenAnswersSchema = z
  .object({
    chips: blockKeyed(z.array(z.number().int())).optional(),
    option: blockKeyed(z.number().int()).optional(),
    slider: blockKeyed(z.number().finite()).optional(),
    text: blockKeyed(z.string()).optional(),
  })
  .strict();

export type EncodedScreenAnswers = z.infer<typeof encodedScreenAnswersSchema>;

export const ANSWER_KINDS = ['chips', 'option', 'slider', 'text'] as const;
export type AnswerKind = (typeof ANSWER_KINDS)[number];

/** One row of `record.screen_answer`, in the terms this service works in. */
export interface BlockAnswer {
  readonly blockIndex: number;
  readonly kind: AnswerKind;
  /** `number[]` for chips, `number` for option/slider, `string` for text. */
  readonly value: readonly number[] | number | string;
}

/**
 * Flattens the four maps into rows, refusing a block claimed by two kinds.
 *
 * `record.screen_answer` is unique on `(enrolment_id, screen_id, block_index)`,
 * so a body that puts block 0 in both `chips` and `slider` describes two rows
 * that cannot both exist. Silently keeping the last one would make the stored
 * record depend on JSON key order, which is not something a client controls or
 * can be asked to reason about — so it is a 400 naming the block.
 */
export function decodeScreenAnswers(
  encoded: EncodedScreenAnswers,
): BlockAnswer[] {
  const byBlock = new Map<number, BlockAnswer>();

  const add = (kind: AnswerKind, blockIndex: number, value: BlockAnswer['value']) => {
    const existing = byBlock.get(blockIndex);
    if (existing) {
      throw problem.validation(
        `Block ${blockIndex} is given as both ${existing.kind} and ${kind}; ` +
          'a block holds one kind of answer.',
        [{ path: `${kind}.${blockIndex}`, message: 'duplicate block index' }],
      );
    }
    byBlock.set(blockIndex, { blockIndex, kind, value });
  };

  for (const [key, value] of Object.entries(encoded.chips ?? {})) {
    // Sorted, for the same reason the app sorts: a Set has no order, and an
    // unordered encoding makes two identical records compare unequal — which
    // in `POST /sync` would turn an idempotent re-send into a write.
    add('chips', Number(key), [...value].sort((a, b) => a - b));
  }
  for (const [key, value] of Object.entries(encoded.option ?? {})) {
    add('option', Number(key), value);
  }
  for (const [key, value] of Object.entries(encoded.slider ?? {})) {
    add('slider', Number(key), value);
  }
  for (const [key, value] of Object.entries(encoded.text ?? {})) {
    add('text', Number(key), value);
  }

  return [...byBlock.values()].sort((a, b) => a.blockIndex - b.blockIndex);
}

/**
 * Rows back into the app's four maps.
 *
 * Always all four keys, even when empty, because that is what `_encodeAnswers`
 * writes and a client comparing its snapshot against a server response should
 * not have to special-case an absent map.
 */
export function encodeScreenAnswers(
  blocks: readonly BlockAnswer[],
): Required<EncodedScreenAnswers> {
  const encoded: Required<EncodedScreenAnswers> = {
    chips: {},
    option: {},
    slider: {},
    text: {},
  };

  for (const block of blocks) {
    const key = String(block.blockIndex);
    switch (block.kind) {
      case 'chips':
        encoded.chips[key] = (block.value as number[]) ?? [];
        break;
      case 'option':
        encoded.option[key] = block.value as number;
        break;
      case 'slider':
        encoded.slider[key] = block.value as number;
        break;
      case 'text':
        encoded.text[key] = block.value as string;
        break;
    }
  }

  return encoded;
}

/**
 * Splits an `areaId/screenId` key from the app's flat `answers` map.
 *
 * Returns null for a key with no separator. The app's `restoreFrom` drops those
 * rather than guessing, and its reasoning transfers exactly: a key naming a
 * screen and no programme is a version 1 key, `behavioral` and `digital` both
 * resolve to the `lookup` product, and filing such an answer under whichever
 * programme looks likely is the cross-programme merge this backend exists to
 * make unrepresentable. The difference is that a server can *tell* the client,
 * so the caller gets it back in `rejected[]` instead of losing it in silence.
 */
export function splitAnswerKey(
  key: string,
): { areaId: string; screenId: string } | null {
  const slash = key.indexOf('/');
  if (slash <= 0 || slash === key.length - 1) return null;
  const areaId = key.slice(0, slash);
  const screenId = key.slice(slash + 1);
  // Neither half ever contains a slash — area ids come from `areas.json`,
  // screen ids from the journey builder — so a second one means the key was
  // built by something else and should not be guessed at either.
  if (screenId.includes('/')) return null;
  return { areaId, screenId };
}
