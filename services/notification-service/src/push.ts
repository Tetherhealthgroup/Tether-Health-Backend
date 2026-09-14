import type { Logger } from '@tether/core';
import type { NotificationPayload } from './content.ts';

/**
 * The FCM boundary — and the only place in the whole platform that
 * `firebase-admin` is allowed to exist.
 *
 * ARCHITECTURE.md, "The client constraint": `Tether-Health/pubspec.yaml`
 * declares exactly one runtime dependency and
 * `test/no_third_party_sdks_test.dart` fails the build if a second appears:
 *
 *     expect(names, ['flutter'],
 *       reason: 'the app ships with no runtime package outside the Flutter SDK.')
 *
 * and addendum §3.2 forbids third-party SDKs on child profiles outright. So the
 * app receives pushes through the operating system and never links a Firebase
 * SDK. Everything Firebase-shaped is on this side of the network, in this file.
 *
 * ---------------------------------------------------------------------------
 * Why the import is dynamic
 * ---------------------------------------------------------------------------
 *
 * A developer running the stack locally has no service-account JSON, should not
 * be asked to get one, and should not have to go looking for a plausible fake.
 * A static `import 'firebase-admin'` would still resolve, but `initializeApp`
 * without credentials throws at boot — so the service would refuse to start
 * over a dependency that nothing on a laptop can exercise anyway.
 *
 * With the import deferred, absent credentials produce a `Pusher` that records
 * what it would have sent and delivers nothing. Every other route behaves
 * normally, and the delivery record says `provider: 'disabled'` so a quiet
 * local run is distinguishable from a provider outage after the fact.
 *
 * The specifier is held in a variable so the type checker does not resolve it.
 * That keeps this file compiling in a checkout where the optional dependency
 * was not installed, which is the situation the whole design is for.
 *
 * `firebase-admin` is declared in `optionalDependencies` for the same reason:
 * `npm install` on a laptop or in CI succeeds whether or not it resolves, and
 * nothing in the test suite needs it. The safety net for the case that matters
 * — a production deploy that has credentials and no package — is at the bottom
 * of `createPusher`: with `NODE_ENV=production` and a service account present,
 * a failed import throws and the service does not start. Push being quietly off
 * in production is the one outcome this file will not produce.
 */

export interface SendOutcome {
  readonly provider: 'fcm' | 'disabled';
  readonly delivered: number;
  readonly failed: number;
  /**
   * Tokens FCM says are dead. Uninstalls and reinstalls are constant, and a
   * table of tokens nothing prunes grows until most of a send is wasted.
   */
  readonly staleTokens: readonly string[];
}

export interface Pusher {
  readonly enabled: boolean;
  send(
    tokens: readonly string[],
    payload: NotificationPayload,
    data: Readonly<Record<string, string>>,
  ): Promise<SendOutcome>;
}

export interface PusherOptions {
  /** The contents of `FIREBASE_SERVICE_ACCOUNT_JSON`, if it was set. */
  readonly serviceAccountJson: string | undefined;
  readonly projectId: string | undefined;
  readonly logger: Logger;
  readonly environment: string;
}

/** FCM's ceiling for one multicast call. */
const BATCH = 500;

/** The error codes that mean "this token is gone", not "try again". */
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

/**
 * Just enough of `firebase-admin` to call it, declared locally.
 *
 * Structural, so it does not depend on the package's own types being installed.
 * Narrow on purpose: if the real signature changes, this breaks at the one call
 * site rather than everywhere.
 */
interface MulticastResponse {
  readonly successCount: number;
  readonly failureCount: number;
  readonly responses: ReadonlyArray<{
    readonly success: boolean;
    readonly error?: { readonly code?: string };
  }>;
}

interface Messaging {
  sendEachForMulticast(message: unknown): Promise<MulticastResponse>;
}

const DISABLED_OUTCOME: SendOutcome = {
  provider: 'disabled',
  delivered: 0,
  failed: 0,
  staleTokens: [],
};

/**
 * Builds a pusher, with or without Firebase.
 *
 * Malformed credentials are treated differently from absent ones. Absent is a
 * laptop. Malformed in production is a deploy that believes it can send and
 * cannot, which is worse than not starting — so it throws there and degrades
 * everywhere else.
 */
export async function createPusher(options: PusherOptions): Promise<Pusher> {
  const { serviceAccountJson, logger, environment } = options;

  if (!serviceAccountJson || serviceAccountJson.trim() === '') {
    logger.warn(
      { provider: 'disabled' },
      'FIREBASE_SERVICE_ACCOUNT_JSON is not set: push delivery is disabled. ' +
        'Device registration, preferences and the delivery log all still work.',
    );
    return { enabled: false, send: async () => DISABLED_OUTCOME };
  }

  try {
    const credential: unknown = JSON.parse(serviceAccountJson);

    // Variable specifiers, so neither the type checker nor a bundler tries to
    // resolve `firebase-admin` in a checkout that does not have it.
    // Annotated `string`, not left to infer a literal type: TypeScript resolves
    // `import()` of a string *literal* and would then demand the package's
    // types be installed, which is the requirement this file exists to avoid.
    const appModule: string = 'firebase-admin/app';
    const messagingModule: string = 'firebase-admin/messaging';

    const { initializeApp, cert, getApps } = (await import(appModule)) as {
      initializeApp: (config: unknown, name?: string) => unknown;
      cert: (serviceAccount: unknown) => unknown;
      getApps: () => unknown[];
    };
    const { getMessaging } = (await import(messagingModule)) as {
      getMessaging: (app?: unknown) => Messaging;
    };

    // A named app rather than the default one. Nothing else in this process
    // uses firebase-admin today, and a named app means that stays true if
    // something ever does — two libraries racing to initialise the default app
    // is a startup failure that reads like a credentials problem.
    //
    // Reusing an app that is already there matters for the same reason: a hot
    // reload, or a second `createPusher` in a test, hits `initializeApp` with a
    // name that exists, and that throws.
    const name = 'tether-notification';
    const existing = getApps().find(
      (app) => (app as { name?: string } | null)?.name === name,
    );
    const app =
      existing ??
      initializeApp(
        {
          credential: cert(credential),
          ...(options.projectId ? { projectId: options.projectId } : {}),
        },
        name,
      );

    const messaging = getMessaging(app);

    logger.info({ provider: 'fcm' }, 'push delivery enabled');

    return {
      enabled: true,
      async send(tokens, payload, data) {
        if (tokens.length === 0) {
          return { provider: 'fcm', delivered: 0, failed: 0, staleTokens: [] };
        }

        let delivered = 0;
        let failed = 0;
        const staleTokens: string[] = [];

        for (let offset = 0; offset < tokens.length; offset += BATCH) {
          const chunk = tokens.slice(offset, offset + BATCH);

          const response = await messaging.sendEachForMulticast({
            tokens: chunk,
            notification: { title: payload.title, body: payload.body },
            data,
            android: {
              priority: 'high',
              notification: {
                // Android's own lock-screen control. `private` means the OS
                // hides the content on a secure lock screen even if the body
                // were specific — belt as well as braces, since the body is
                // already generic unless the account opted in.
                visibility: 'private',
                channelId: 'tether_reminders',
              },
            },
            apns: {
              payload: {
                aps: {
                  sound: 'default',
                  // iOS shows a notification-service extension the chance to
                  // replace the body after the device is unlocked. The app does
                  // not ship one today; the flag is what makes adding one
                  // possible without changing this service.
                  'mutable-content': 1,
                },
              },
            },
          });

          delivered += response.successCount;
          failed += response.failureCount;

          response.responses.forEach((result, index) => {
            if (result.success) return;
            const code = result.error?.code;
            const token = chunk[index];
            if (token && code && DEAD_TOKEN_CODES.has(code)) {
              staleTokens.push(token);
            }
          });
        }

        return { provider: 'fcm', delivered, failed, staleTokens };
      },
    };
  } catch (error) {
    if (environment === 'production') {
      // Credentials that are present and unusable is a configuration error, and
      // a production service that silently sends nothing is the failure mode
      // nobody notices until somebody misses a dose.
      throw new Error(
        'FIREBASE_SERVICE_ACCOUNT_JSON is set but firebase-admin could not be ' +
          'initialised. Refusing to start in production with push silently off.',
        { cause: error },
      );
    }
    logger.error(
      { err: error, provider: 'disabled' },
      'firebase-admin failed to initialise; continuing with push disabled',
    );
    return { enabled: false, send: async () => DISABLED_OUTCOME };
  }
}
