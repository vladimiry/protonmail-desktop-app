import {concatMap, delay, retryWhen} from "rxjs/operators";
import {from, of, throwError} from "rxjs";

import {DbPatch} from "src/shared/api/common";
import {FsDbAccount} from "src/shared/model/database";
import {IpcMainApiEndpoints} from "src/shared/api/main";
import {Logger} from "src/shared/model/common";
import {ONE_SECOND_MS} from "src/shared/constants";
import {asyncDelay, curryFunctionMembers, isDatabaseBootstrapped} from "src/shared/util";
import {resolveCachedConfig, resolveIpcMainApi} from "src/electron-preload/lib/util";

export const resolveDomElements = async <E extends Element | null,
    Q extends Readonly<Record<string, () => E>>,
    K extends keyof Q,
    R extends { [key in K]: Exclude<ReturnType<Q[key]>, null> }>(
    query: Q,
    logger: Logger,
    opts: { timeoutMs?: number; iterationsLimit?: number } = {},
): Promise<R> => {
    const {timeouts: {domElementsResolving}} = await resolveCachedConfig(logger);

    return new Promise((resolve, reject) => {
        const OPTS = {
            timeoutMs: (
                opts.timeoutMs
                ??
                domElementsResolving
                ??
                ONE_SECOND_MS * 10
            ),
            iterationsLimit: opts.iterationsLimit || 0, // 0 - unlimited
            delayMinMs: 300,
        };

        const startTime = Date.now();
        const delayMs = OPTS.timeoutMs / 50;
        const queryKeys: K[] = Object.keys(query) as K[];
        const resolvedElements: Partial<R> = {};
        let it = 0;

        const scanElements: () => void = () => {
            it++;

            queryKeys.forEach((key) => {
                if (key in resolvedElements) {
                    return;
                }
                const element = query[key]();
                if (element) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any,  @typescript-eslint/no-unsafe-assignment
                    resolvedElements[key] = element as any;
                }
            });

            if (Object.keys(resolvedElements).length === queryKeys.length) {
                return resolve(resolvedElements as R);
            }

            if (OPTS.iterationsLimit && (it >= OPTS.iterationsLimit)) {
                return reject(
                    new Error(
                        `Failed to resolve some DOM elements from the list [${queryKeys.join(", ")}] having "${it}" iterations performed`,
                    ),
                );
            }

            if (Date.now() - startTime > OPTS.timeoutMs) {
                return reject(new Error(
                    `Failed to resolve some DOM elements from the list [${queryKeys.join(", ")}] within "${OPTS.timeoutMs}" milliseconds`,
                ));
            }

            setTimeout(scanElements, Math.max(OPTS.delayMinMs, delayMs));
        };

        scanElements();
    });
};

export function getLocationHref(): string {
    return window.location.href;
}

export function fillInputValue(input: HTMLInputElement, value: string): void {
    const setValue = (() => {
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const valueSetter = Object.getOwnPropertyDescriptor(input, "value")?.set;
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const prototypeValueSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;

        return prototypeValueSetter && valueSetter !== prototypeValueSetter
            ? prototypeValueSetter
            : valueSetter;
    })();

    if (!setValue) {
        throw new Error("Form input control value setter resolving failed");
    }

    setValue.call(input, value);
    input.dispatchEvent(new Event("input", {bubbles: true}));
}

export async function submitTotpToken(
    input: HTMLInputElement,
    button: HTMLElement,
    resolveToken: () => Promise<string>,
    _logger: Logger,
    {
        submitTimeoutMs = ONE_SECOND_MS * 8,
        newTokenDelayMs = ONE_SECOND_MS * 2,
        submittingDetection,
    }: {
        submitTimeoutMs?: number;
        newTokenDelayMs?: number;
        submittingDetection?: () => Promise<boolean>;
    } = {},
): Promise<void> {
    const logger = curryFunctionMembers(_logger, "submitTotpToken()");

    logger.info();

    if (input.value) {
        throw new Error("2FA TOTP token is not supposed to be pre-filled on this stage");
    }

    const errorMessage = `Failed to submit two factor token within ${submitTimeoutMs}ms`;

    const submit: () => Promise<void> = async () => {
        logger.verbose("submit - start");

        const submitted: () => Promise<boolean> = (
            submittingDetection
            ||
            ((urlBeforeSubmit = getLocationHref()) => {
                return async () => getLocationHref() !== urlBeforeSubmit;
            })()
        );

        fillInputValue(input, await resolveToken());
        logger.verbose("input filled");

        button.click();
        logger.verbose("clicked");

        await asyncDelay(submitTimeoutMs);

        // TODO consider using unified submitting detection
        //      like for example testing that input/button elements no longer attached to DOM or visible
        if (
            !(await submitted())
        ) {
            throw new Error(errorMessage);
        }

        logger.verbose("submit - success");
    };

    try {
        await submit();
    } catch (e) {
        const {message} = e; // eslint-disable-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment

        if (message !== errorMessage) {
            throw e;
        }

        logger.verbose(`submit 1 - fail: ${String(message)}`);
        // second attempt as token might become expired right before submitting
        await asyncDelay(newTokenDelayMs, submit);
    }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type, @typescript-eslint/explicit-module-boundary-types
export function buildDbPatchRetryPipeline<T>(
    preprocessError: (rawError: unknown) => { error: Error; retriable: boolean; skippable: boolean },
    metadata: FsDbAccount["metadata"] | null,
    logger: Logger,
    {retriesDelay = ONE_SECOND_MS * 5, retriesLimit = 3}: { retriesDelay?: number; retriesLimit?: number } = {},
) {
    const errorResult = (error: Error): ReturnType<typeof throwError> => {
        logger.error(error);
        return throwError(error);
    };

    return retryWhen<T>((errors) => errors.pipe(
        concatMap((rawError, retryIndex) => {
            const {error, retriable, skippable} = preprocessError(rawError);

            if (!isDatabaseBootstrapped(metadata)) {
                // no retrying for initial/bootstrap fetch
                return errorResult(error);
            }

            if (retryIndex >= retriesLimit) {
                if (skippable) {
                    const message = `Skipping "buildDbPatch" call`;
                    logger.warn(message, error);
                    return from(Promise.resolve());
                }
                return errorResult(error);
            }

            if (retriable) {
                logger.warn(`Retrying "buildDbPatch" call (attempt: "${retryIndex}")`);
                return of(error).pipe(
                    delay(retriesDelay),
                );
            }

            return errorResult(error);
        }),
    ));
}

export async function persistDatabasePatch(
    data: Parameters<IpcMainApiEndpoints["dbPatch"]>[0],
    logger: Logger,
): Promise<void> {
    logger.info("persist() start");

    await resolveIpcMainApi({logger})("dbPatch")({
        login: data.login,
        metadata: data.metadata,
        patch: data.patch,
    });

    logger.info("persist() end");
}

export function buildEmptyDbPatch(): DbPatch {
    return {
        conversationEntries: {remove: [], upsert: []},
        mails: {remove: [], upsert: []},
        folders: {remove: [], upsert: []},
        contacts: {remove: [], upsert: []},
    };
}

export function disableBrowserNotificationFeature(parentLogger: Logger): void {
    delete (window as Partial<Pick<typeof window, "Notification">>).Notification;
    parentLogger.info(`browser "notification" feature disabled`);
}