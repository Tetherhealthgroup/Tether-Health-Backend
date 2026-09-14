import { writeFileSync } from 'node:fs';
import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import * as catalogue from './catalogue.ts';
import * as enrolment from './enrolment.ts';
import * as primitives from './primitives.ts';

/**
 * Generates the published OpenAPI document from the schemas the services
 * actually validate with.
 *
 * Written as a generator rather than a checked-in YAML file for one reason:
 * the repo this backend is modelled on kept its API documentation by hand, and
 * by the time anyone looked it described endpoints that had been renamed and
 * omitted five that existed. A document derived from the validators cannot say
 * a field is optional while the validator rejects its absence.
 *
 * OpenAPI 3.1 rather than 3.0, because 3.1 *is* JSON Schema 2020-12 — so a
 * nullable field can be emitted as `type: ['string','null']` exactly as the
 * schema means it, instead of 3.0's `nullable: true` extension, which several
 * generators quietly ignore.
 *
 *     npm run openapi            # writes openapi.json at the repo root
 *     npm run openapi -- -       # writes to stdout
 */

/**
 * Every named schema the document exposes, in `components/schemas`.
 *
 * The primitives are listed as well as the aggregates. Without them the
 * generator still deduplicates a shape it meets twice, but it does so by
 * pointing at wherever it happened to see it first —
 * `#/components/schemas/Area/properties/id`. That is a legal JSON pointer and
 * an unreadable one, and several client generators refuse a `$ref` that is not
 * a component. Naming the primitives makes the dedup target a component.
 */
const REGISTRY: Record<string, ZodTypeAny> = {
  // primitives
  Slug: primitives.SlugSchema,
  ScreenId: primitives.ScreenIdSchema,
  Locale: primitives.LocaleSchema,
  Uuid: primitives.UuidSchema,
  Instant: primitives.InstantSchema,
  JsonObject: primitives.JsonObjectSchema,
  Provenance: primitives.ProvenanceSchema,

  // catalogue
  Area: catalogue.AreaSchema,
  AreaStatus: catalogue.AreaStatusSchema,
  ServiceLine: catalogue.ServiceLineSchema,
  Measure: catalogue.MeasureSchema,
  Safeguard: catalogue.SafeguardSchema,
  ShellRule: catalogue.ShellRuleSchema,
  Archetype: catalogue.ArchetypeSchema,
  Product: catalogue.ProductSchema,
  ProductScreen: catalogue.ProductScreenSchema,
  ScreenContent: catalogue.ScreenContentSchema,
  AreasResponse: catalogue.AreasResponseSchema,
  ArchetypesResponse: catalogue.ArchetypesResponseSchema,
  SafeguardsResponse: catalogue.SafeguardsResponseSchema,
  ShellRulesResponse: catalogue.ShellRulesResponseSchema,
  ContentPackResponse: catalogue.ContentPackResponseSchema,
  BundleResponse: catalogue.BundleResponseSchema,

  // enrolment
  Enrolment: enrolment.EnrolmentSchema,
  EnrolmentStatus: enrolment.EnrolmentStatusSchema,
  SharingConsent: enrolment.SharingConsentSchema,
  SharingScope: enrolment.SharingScopeSchema,
  RecipientKind: enrolment.RecipientKindSchema,
  EnrolmentsResponse: enrolment.EnrolmentsResponseSchema,
  JoinEnrolmentRequest: enrolment.JoinEnrolmentRequestSchema,
  UpdateEnrolmentRequest: enrolment.UpdateEnrolmentRequestSchema,
  SharingRequest: enrolment.SharingRequestSchema,
  SharingResponse: enrolment.SharingResponseSchema,
  SharePreviewPayload: enrolment.SharePreviewPayloadSchema,
  SharePreviewEntry: enrolment.SharePreviewEntrySchema,
  SharePreviewResponse: enrolment.SharePreviewResponseSchema,
};

/**
 * RFC 7807, mirrored from `@tether/core`'s `ProblemBody`.
 *
 * Hand-written here rather than imported, because `core` defines it as a
 * TypeScript interface on the error class and importing `core` would drag
 * `pg`, `pino` and `express` onto the import path of a script whose only job is
 * to write a JSON file. The duplication is four fields wide and is the reason
 * `problemTypes` below is enumerated: if the two drift, the enumerated list is
 * what a reviewer notices.
 */
const PROBLEM_SCHEMA = {
  type: 'object',
  required: ['type', 'title', 'status', 'detail'],
  properties: {
    type: { type: 'string', format: 'uri' },
    title: { type: 'string' },
    status: { type: 'integer' },
    detail: { type: 'string' },
    instance: { type: 'string' },
    requestId: { type: 'string' },
    errors: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'message'],
        properties: {
          path: { type: 'string' },
          message: { type: 'string' },
        },
      },
    },
  },
} as const;

/** The `type` values these two services can return. Mirrors `core`'s `ProblemType`. */
const PROBLEM_TYPES = [
  'validation-failed',
  'unauthenticated',
  'forbidden',
  'not-found',
  'conflict',
  'at-programme-ceiling',
  'area-not-implemented',
  'consent-required',
  'rate-limited',
  'internal-error',
] as const;

function ref(name: string): { $ref: string } {
  return { $ref: `#/components/schemas/${name}` };
}

function problemResponse(description: string): unknown {
  return {
    description,
    content: {
      'application/problem+json': { schema: ref('Problem') },
    },
  };
}

function jsonResponse(description: string, schema: string): unknown {
  return {
    description,
    content: { 'application/json': { schema: ref(schema) } },
  };
}

/** A path parameter, required by definition. */
function pathParam(name: string, description: string): unknown {
  return {
    name,
    in: 'path',
    required: true,
    description,
    schema: { type: 'string' },
  };
}

function queryParam(
  name: string,
  description: string,
  schema: unknown,
): unknown {
  return { name, in: 'query', required: false, description, schema };
}

/**
 * The responses every authenticated endpoint can produce.
 *
 * Attached to all of them rather than to the ones a reader would think of,
 * because a client that has not been told 429 is possible is a client that
 * treats a rate limit as an outage.
 */
const COMMON_RESPONSES = {
  '401': problemResponse('No credentials, or credentials that did not verify.'),
  '429': problemResponse('Rate limited.'),
  '500': problemResponse('Unhandled failure. Never carries underlying detail.'),
};

/**
 * Responses shared by every catalogue read.
 *
 * `304` is listed on each one deliberately. The catalogue changes rarely and
 * every cold app start fetches all of it, so the conditional request is the
 * normal case rather than an optimisation, and a generated client that does not
 * know 304 is a valid outcome will treat the common path as an error.
 */
const CACHEABLE_RESPONSES = {
  '304': {
    description:
      'The caller\'s `If-None-Match` matched. No body; the cached copy stands.',
  },
  ...COMMON_RESPONSES,
};

const CACHE_HEADERS = [
  {
    name: 'If-None-Match',
    in: 'header',
    required: false,
    description:
      'The ETag of the copy the caller already holds. A match answers 304 with no body.',
    schema: { type: 'string' },
  },
];

function buildPaths(): Record<string, unknown> {
  return {
    // -----------------------------------------------------------------------
    // catalogue-service :8002
    // -----------------------------------------------------------------------
    '/areas': {
      get: {
        tags: ['catalogue'],
        summary: 'Every health area, with its service lines, measures and safeguard ids.',
        parameters: [
          ...CACHE_HEADERS,
          queryParam('status', 'Return only areas at this stage.', {
            type: 'string',
            enum: ['in_development', 'design', 'planned'],
          }),
        ],
        responses: {
          '200': jsonResponse('The areas.', 'AreasResponse'),
          '400': problemResponse('Unknown status value.'),
          ...CACHEABLE_RESPONSES,
        },
      },
    },
    '/areas/{areaId}': {
      get: {
        tags: ['catalogue'],
        summary: 'One area.',
        parameters: [
          ...CACHE_HEADERS,
          pathParam('areaId', 'The app spelling, e.g. `kidney_liver`.'),
        ],
        responses: {
          '200': jsonResponse('The area.', 'Area'),
          '404': problemResponse('No such area.'),
          ...CACHEABLE_RESPONSES,
        },
      },
    },
    '/archetypes': {
      get: {
        tags: ['catalogue'],
        summary: 'Every screen archetype, carrying its provenance.',
        parameters: CACHE_HEADERS,
        responses: {
          '200': jsonResponse('The archetypes.', 'ArchetypesResponse'),
          ...CACHEABLE_RESPONSES,
        },
      },
    },
    '/archetypes/{archetypeId}': {
      get: {
        tags: ['catalogue'],
        summary: 'One archetype.',
        parameters: [...CACHE_HEADERS, pathParam('archetypeId', 'e.g. `welcome`.')],
        responses: {
          '200': jsonResponse('The archetype.', 'Archetype'),
          '404': problemResponse('No such archetype.'),
          ...CACHEABLE_RESPONSES,
        },
      },
    },
    '/safeguards': {
      get: {
        tags: ['catalogue'],
        summary: 'The twenty safeguards, with what they require and forbid.',
        parameters: CACHE_HEADERS,
        responses: {
          '200': jsonResponse('The safeguards.', 'SafeguardsResponse'),
          ...CACHEABLE_RESPONSES,
        },
      },
    },
    '/shell-rules': {
      get: {
        tags: ['catalogue'],
        summary: 'The shell rules, each with the reasoning the client renders.',
        parameters: CACHE_HEADERS,
        responses: {
          '200': jsonResponse('The rules.', 'ShellRulesResponse'),
          ...CACHEABLE_RESPONSES,
        },
      },
    },
    '/products/{productId}': {
      get: {
        tags: ['catalogue'],
        summary: 'One product and its screen list.',
        parameters: [...CACHE_HEADERS, pathParam('productId', '`breathefree` or `lookup`.')],
        responses: {
          '200': jsonResponse('The product.', 'Product'),
          '404': problemResponse('No such product.'),
          ...CACHEABLE_RESPONSES,
        },
      },
    },
    '/products/{productId}/content/{locale}': {
      get: {
        tags: ['catalogue'],
        summary:
          'The content pack, including supplement-provenance screens. Every entry carries `provenance`.',
        parameters: [
          ...CACHE_HEADERS,
          pathParam('productId', '`breathefree` or `lookup`.'),
          pathParam('locale', 'e.g. `en`.'),
        ],
        responses: {
          '200': jsonResponse('The content pack.', 'ContentPackResponse'),
          '404': problemResponse('No such product, or no content in that locale.'),
          ...CACHEABLE_RESPONSES,
        },
      },
    },
    '/bundle': {
      get: {
        tags: ['catalogue'],
        summary: 'Everything, in one response, for a cold client start.',
        parameters: [
          ...CACHE_HEADERS,
          queryParam('locale', 'Which content pack to include. Defaults to `en`.', {
            type: 'string',
            default: 'en',
          }),
        ],
        responses: {
          '200': jsonResponse('The bundle.', 'BundleResponse'),
          ...CACHEABLE_RESPONSES,
        },
      },
    },

    // -----------------------------------------------------------------------
    // enrolment-service :8003
    // -----------------------------------------------------------------------
    '/enrolments': {
      get: {
        tags: ['enrolment'],
        summary: "The caller's enrolments, each with its live sharing consents.",
        responses: {
          '200': jsonResponse('The enrolments.', 'EnrolmentsResponse'),
          ...COMMON_RESPONSES,
        },
      },
      post: {
        tags: ['enrolment'],
        summary: 'Join a programme, optionally pausing another in the same transaction.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: ref('JoinEnrolmentRequest') } },
        },
        responses: {
          '200': jsonResponse('Already active. Nothing changed.', 'Enrolment'),
          '201': jsonResponse('Joined.', 'Enrolment'),
          '400': problemResponse('Body failed validation.'),
          '409': problemResponse(
            'Either `area-not-implemented` (the area has no product) or ' +
              '`at-programme-ceiling` (two programmes are already active).',
          ),
          ...COMMON_RESPONSES,
        },
      },
    },
    '/enrolments/{areaId}': {
      patch: {
        tags: ['enrolment'],
        summary: 'Pause, resume, end or hide. Resuming is subject to the ceiling.',
        parameters: [pathParam('areaId', 'The area the enrolment is in.')],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: ref('UpdateEnrolmentRequest') } },
        },
        responses: {
          '200': jsonResponse('The updated enrolment.', 'Enrolment'),
          '400': problemResponse('Body failed validation.'),
          '404': problemResponse('No enrolment in that area.'),
          '409': problemResponse('`at-programme-ceiling` on resume.'),
          ...COMMON_RESPONSES,
        },
      },
    },
    '/enrolments/{areaId}/sharing': {
      get: {
        tags: ['enrolment'],
        summary: 'The live sharing consents for one programme. Revoked grants are absent.',
        parameters: [pathParam('areaId', 'The area the enrolment is in.')],
        responses: {
          '200': jsonResponse('The live consents.', 'SharingResponse'),
          '404': problemResponse('No enrolment in that area.'),
          ...COMMON_RESPONSES,
        },
      },
      put: {
        tags: ['enrolment'],
        summary:
          'Grant or revoke one consent. A body that names an account rather than a programme is refused.',
        parameters: [pathParam('areaId', 'The area the enrolment is in.')],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: ref('SharingRequest') } },
        },
        responses: {
          '200': jsonResponse('The live consents after the change.', 'SharingResponse'),
          '400': problemResponse(
            'Body failed validation — including any body shaped like a global, ' +
              'account-level grant. There is no account-level sharing, by design.',
          ),
          '404': problemResponse('No enrolment in that area.'),
          ...COMMON_RESPONSES,
        },
      },
    },
    '/enrolments/{areaId}/sharing/preview': {
      get: {
        tags: ['enrolment'],
        summary:
          'Exactly what a recipient would receive. Sends nothing — the `share_preview` safeguard.',
        parameters: [
          pathParam('areaId', 'The area the enrolment is in.'),
          queryParam('scope', 'With recipientKind, previews a grant not yet made.', {
            type: 'string',
            enum: ['totals_and_adherence', 'notes'],
          }),
          queryParam('recipientKind', 'With scope, previews a grant not yet made.', {
            type: 'string',
            enum: ['coach', 'care_team', 'supporter'],
          }),
        ],
        responses: {
          '200': jsonResponse('The preview.', 'SharePreviewResponse'),
          '400': problemResponse('Only one of scope and recipientKind was given.'),
          '404': problemResponse('No enrolment in that area.'),
          ...COMMON_RESPONSES,
        },
      },
    },
  };
}

/**
 * Converts the registry to `components/schemas`.
 *
 * `$refStrategy: 'root'` so a schema used in six places is emitted once and
 * referenced — the alternative inlines `Area` inside `BundleResponse` inside
 * every response that mentions it, and produces a document large enough that
 * nobody reads it.
 */
export function components(): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};

  for (const [name, schema] of Object.entries(REGISTRY)) {
    const generated = zodToJsonSchema(schema, {
      name,
      $refStrategy: 'root',
      // `basePath` and `definitionPath` are joined by the generator, so this
      // pair yields `#/components/schemas/Name` — the location OpenAPI expects
      // and the location `ref()` above writes.
      basePath: ['#', 'components'],
      definitionPath: 'schemas',
      definitions: REGISTRY,
      target: 'jsonSchema7',
    }) as { schemas?: Record<string, unknown> };

    // With `definitions` supplied, the generator returns every named schema it
    // reached, keyed under `definitionPath`. Taking the whole map on each pass
    // and letting later passes overwrite earlier ones is intentional: the
    // output for a given name is deterministic, so overwriting is a no-op that
    // saves reasoning about which pass happened to visit a nested schema first.
    Object.assign(schemas, generated.schemas ?? {});
  }

  schemas.Problem = PROBLEM_SCHEMA;
  return schemas;
}

export function openApiDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Tether Health API — catalogue and enrolment',
      version: '0.1.0',
      description:
        'The design catalogue (non-PHI, cacheable) and the enrolment surface ' +
        '(PHI-adjacent, row-level-security scoped). Generated from the zod ' +
        'schemas the services validate with; do not edit by hand.',
    },
    servers: [
      { url: 'https://api.tetherhealthgroup.com', description: 'The gateway.' },
      { url: 'http://localhost:8000', description: 'Local gateway.' },
    ],
    tags: [
      {
        name: 'catalogue',
        description:
          'The design bundle. Non-PHI and world-readable to an authenticated ' +
          'client, so every response carries an ETag and a Cache-Control.',
      },
      {
        name: 'enrolment',
        description:
          'Joining, pausing, hiding and per-program sharing consent. Every ' +
          'read and write is scoped to the caller by row-level security.',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas: components(),
    },
    security: [{ bearerAuth: [] }],
    paths: buildPaths(),

    // Not part of the specification. Carried because the `type` field of a
    // problem is the machine-readable half of an error, and a client author
    // should be able to enumerate the values without reading ten route
    // descriptions to find them.
    'x-problem-types': PROBLEM_TYPES,
  };
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (isEntryPoint) {
  const document = JSON.stringify(openApiDocument(), null, 2);
  const target = process.argv[2] ?? new URL('../../../openapi.json', import.meta.url).pathname;

  if (target === '-') {
    process.stdout.write(`${document}\n`);
  } else {
    writeFileSync(target, `${document}\n`);
    process.stdout.write(`wrote ${target}\n`);
  }
}
