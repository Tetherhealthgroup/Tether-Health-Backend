import assert from 'node:assert/strict';
import test from 'node:test';
import { waitlistEnquirySchema } from '../src/schema.ts';

/**
 * These tests are about one property: the shipped Astro client treats any
 * non-2xx as a failure and redirects to `mailto:`, so every rejection here is
 * an enquiry the company may never see. They assert leniency, not correctness.
 */

void test('accepts the exact payload WaitlistForm.astro sends', () => {
  const result = waitlistEnquirySchema.safeParse({
    name: 'Alex Carter',
    email: 'alex@example.com',
    role: 'Clinician or care-team member',
    interest: 'Tobacco and nicotine',
    message: 'Interested in the cessation programme for our clinic.',
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.data, {
    name: 'Alex Carter',
    email: 'alex@example.com',
    role: 'Clinician or care-team member',
    interest: 'Tobacco and nicotine',
    message: 'Interested in the cessation programme for our clinic.',
  });
});

void test('the two optional fields may be blank, as the form allows', () => {
  // `name` and `message` are labelled "(optional)" in the form and arrive as
  // empty strings from `normalizeWaitlistPayload`.
  const result = waitlistEnquirySchema.safeParse({
    name: '',
    email: 'someone@example.com',
    role: 'Someone who wants to quit or make a change',
    interest: 'Any / not sure yet',
    message: '',
  });
  assert.equal(result.success, true);
});

void test('missing keys become empty strings rather than a 400', () => {
  const result = waitlistEnquirySchema.safeParse({ email: 'a@b.co' });
  assert.equal(result.success, true);
  assert.equal(result.data?.name, '');
  assert.equal(result.data?.role, '');
  assert.equal(result.data?.interest, '');
  assert.equal(result.data?.message, '');
});

void test('unknown keys are ignored, so the site can add a field first', () => {
  const result = waitlistEnquirySchema.safeParse({
    email: 'a@b.co',
    company: '', // the form's honeypot, if a future version ever forwards it
    organisationSize: '200-500',
  });
  assert.equal(result.success, true);
  assert.equal('company' in (result.data ?? {}), false);
});

void test('an over-long message is truncated, never rejected', () => {
  const result = waitlistEnquirySchema.safeParse({
    email: 'a@b.co',
    message: 'x'.repeat(20_000),
  });
  assert.equal(result.success, true);
  assert.equal(result.data?.message.length, 8_000);
});

void test('whitespace is trimmed off the address before it is stored', () => {
  const result = waitlistEnquirySchema.safeParse({ email: '  a@b.co \n' });
  assert.equal(result.success, true);
  assert.equal(result.data?.email, 'a@b.co');
});

void test('a domain with no dot is accepted, as the browser accepts it', () => {
  // `isReplyableEmail` in the site's own lib permits `someone@intranet`.
  // Disagreeing with the client here would reject submissions it told the
  // visitor were fine.
  assert.equal(waitlistEnquirySchema.safeParse({ email: 'someone@intranet' }).success, true);
});

void test('only an address nothing could be replied to is refused', () => {
  for (const email of ['', '   ', 'nobody', 'a@', '@b.co', 'a b@c.co']) {
    assert.equal(
      waitlistEnquirySchema.safeParse({ email }).success,
      false,
      `expected ${JSON.stringify(email)} to be refused`,
    );
  }
});

void test('a non-text optional field is stored as its text, or blank, never as [object Object]', () => {
  const result = waitlistEnquirySchema.safeParse({
    email: 'a@b.co',
    name: { first: 'Alex' },
    role: 42,
  });
  assert.equal(result.success, true);
  assert.equal(result.data?.name, '');
  assert.equal(result.data?.role, '42');
});
