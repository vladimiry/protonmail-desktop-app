import {URL} from "@cliqz/url-parser";
import {pick} from "remeda";
import {webFrame} from "electron"; // tslint:disable-line:no-import-zones

import {Config} from "src/shared/model/options";
import {DEFAULT_API_CALL_TIMEOUT} from "src/shared/constants";
import {IPC_MAIN_API} from "src/shared/api/main";
import {LOGGER} from "src/electron-preload/lib/electron-exposure/logger";
import {Logger} from "src/shared/model/common";
import {ProtonApiError} from "src/electron-preload/webview/primary/types";
import {curryFunctionMembers} from "src/shared/util";

const depersonalizeLoggedUrl = (url: string): string => {
    if (!new URL(url).pathname) {
        return url;
    }

    const splitBy = "/";
    const splitParts = url.split(splitBy);
    const lastPart = splitParts.pop();

    return [
        ...splitParts,
        // assuming that long last part is not the endpoint name/sub-name but a value/id
        lastPart && lastPart.length >= 15
            ? "<wiped-out>"
            : lastPart,
    ].join(splitBy);
};

export const buildLoggerBundle = (prefix: string): Logger => curryFunctionMembers(LOGGER, prefix);

// TODO apply "zoomFactor" in main process only, track of https://github.com/electron/electron/issues/10572
export const applyZoomFactor = (_logger: Logger): void => {
    const logger = curryFunctionMembers(_logger, "applyZoomFactor()");

    logger.verbose();

    (async () => {
        const {zoomFactor} = await resolveCachedConfig(logger);
        const webFrameZoomFactor = webFrame.getZoomFactor();

        logger.verbose("config.zoomFactor", JSON.stringify(zoomFactor));
        logger.verbose("webFrame.getZoomFactor() (before)", JSON.stringify(webFrameZoomFactor));

        if (webFrameZoomFactor !== zoomFactor) {
            webFrame.setZoomFactor(zoomFactor);
            logger.verbose("webFrame.getZoomFactor() (after)", JSON.stringify(webFrame.getZoomFactor()));
        }
    })().catch((error) => {
        console.error(error); // eslint-disable-line no-console
        logger.error(error);
    });
};

export const isProtonApiError = (
    error: unknown | ProtonApiError
): error is ProtonApiError => {
    const result = (
        typeof error === "object"
        &&
        typeof (error as ProtonApiError).name === "string"
        &&
        typeof (error as ProtonApiError).message === "string"
        &&
        !isNaN(
            Number(
                (error as ProtonApiError).status
            ),
        )
        &&
        (
            typeof (error as ProtonApiError).response === "object"
            ||
            ["AbortError", "TimeoutError", "OfflineError"].includes((error as ProtonApiError).name)
        )
    );

    if (BUILD_ENVIRONMENT === "development" && result) {
        console.log(`isProtonApiError() result:`, {error}, JSON.stringify({result})); // eslint-disable-line no-console
    }

    return result;
};

type SanitizedProtonApiError = NoExtraProps<Pick<ProtonApiError, "name" | "message" | "status">
    & { responseUrl?: string; responseStatusText?: string; dataCode?: number; dataError?: string; dataErrorDescription?: string }>;

export const sanitizeProtonApiError = <T extends unknown>(
    error: T
): typeof error extends ProtonApiError ? SanitizedProtonApiError : unknown => {
    if (isProtonApiError(error)) {
        const result: SanitizedProtonApiError = {
            // omitting possibly sensitive or unserializable data
            // unserializable issue case: we send the error to main process via IPC
            ...pick(error, ["name", "message", "status"]),
            responseUrl: error.response?.url && depersonalizeLoggedUrl(error.response?.url),
            responseStatusText: error.response?.statusText,
            dataCode: error.data?.Code,
            dataError: typeof error.data?.Error === "string" ? error.data?.Error : undefined,
            dataErrorDescription: typeof error.data?.ErrorDescription === "string" ? error.data?.ErrorDescription : undefined,
        };
        return result as any; // eslint-disable-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return
    }
    return error as any; // eslint-disable-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return
};

export const resolveIpcMainApi = (
    {
        timeoutMs = DEFAULT_API_CALL_TIMEOUT,
        ...restOptions
    }: Exclude<Required<Parameters<typeof IPC_MAIN_API.client>[0]>, undefined>["options"],
): ReturnType<typeof IPC_MAIN_API.client> => {
    return IPC_MAIN_API.client({options: {timeoutMs, ...restOptions}});
};

export const resolveCachedConfig: (
    logger: Logger,
) => Promise<Config> = (
    () => {
        let value: Config | undefined;
        const result: typeof resolveCachedConfig = async (logger) => {
            if (value) {
                return value;
            }
            return value = await resolveIpcMainApi({logger})("readConfig")();
        };
        return result;
    }
)();