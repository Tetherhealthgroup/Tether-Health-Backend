import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { createLogger, serializeError } from '../src/logger.ts';

/**
 * What would actually be shipped to the log collector, read back as text.
 *
 * Every assertion below is on the serialised line rather than on the object
 * handed to the logger, because the line is the thing that leaves the process.
 */
function capture(): { lines: () => string[]; logger: ReturnType<typeof createLogger> } {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  const logger = createLogger({
    serviceName: 'test-service',
    level: 'trace',
    environment: 'test',
    destination,
  });
  return { logger, lines: () => chunks.join('').split('\n').filter(Boolean) };
}

test('a metric key, a reading and a drug name are redacted one level down', () => {
  const { logger, lines } = capture();

  logger.info(
    {
      vital: {
        metricKey: 'blood_glucose',
        metric_key: 'blood_glucose',
        value_num: '7.4',
        value_text: 'felt dizzy',
        measureId: 'peak_flow',
      },
      medication: { dosage: '10 mg' },
      condition: { conditionKind: 'diabetes' },
    },
    'recorded',
  );

  const line = lines().join('\n');
  for (const secret of ['blood_glucose', '7.4', 'felt dizzy', 'peak_flow', '10 mg', 'diabetes']) {
    assert.ok(!line.includes(secret), `the log line still contains "${secret}"`);
  }
  assert.match(line, /\[REDACTED\]/);
});

test('a database error does not carry the row it was about into the log', () => {
  const { logger, lines } = capture();

  // The shape `pg` gives a check or not-null violation: the message is generic,
  // and `detail` is the row.
  const error = Object.assign(new Error('new row for relation "vital_entry" violates check constraint'), {
    code: '23514',
    constraint: 'vital_entry_value_check',
    detail: 'Failing row contains (glucose_fasting, Fasting glucose, 9.9, mmol/L, dizzy after lunch).',
    where: 'SQL statement "INSERT INTO chronic.vital_entry ... 9.9"',
    hint: 'metric glucose_fasting',
  });

  logger.error({ err: error }, 'request failed');

  const line = lines().join('\n');
  assert.ok(!line.includes('glucose_fasting'), 'the metric key reached the log');
  assert.ok(!line.includes('9.9'), 'the reading reached the log');
  assert.ok(!line.includes('dizzy after lunch'), 'the note reached the log');

  // What is useful for an incident is kept: which statement class and which
  // constraint, without the data.
  assert.match(line, /23514/);
  assert.match(line, /vital_entry_value_check/);
});

test('a row-bearing field on a wrapped cause does not surface either', () => {
  const inner = Object.assign(new Error('inner'), {
    detail: 'Key (email)=(a@example.test) already exists.',
  });
  const out = serializeError(new Error('outer', { cause: inner }));

  // pino folds a cause into `message` and `stack`; its own properties are not
  // copied, which is what keeps `detail` out. Asserted so an upgrade that
  // starts copying them fails here instead of in a log index.
  assert.ok(!JSON.stringify(out).includes('a@example.test'));
});
