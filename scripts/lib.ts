import byline from "byline";
import fetch from "electron-fetch";
import fs from "fs";
import fsExtra from "fs-extra";
import os from "os";
import path from "path";
import spawnAsync from "@expo/spawn-async";
import {URL} from "@cliqz/url-parser";
import {createHash} from "crypto";
import {omit, pick} from "remeda";
import {promisify} from "util";

import {GIT_CLONE_ABSOLUTE_DIR, OUTPUT_ABSOLUTE_DIR} from "scripts/const";
import {PROVIDER_REPO_MAP} from "src/shared/proton-apps-constants";

// eslint-disable-next-line no-console
export const CONSOLE_LOG = console.log.bind(console);

export function resolveGitOutputBackupDir(
    {
        repoType,
        commit = PROVIDER_REPO_MAP[repoType].commit,
        suffix,
    }: {
        repoType: keyof typeof PROVIDER_REPO_MAP,
        commit?: string,
        suffix?: string,
    },
): string {
    return path.join(
        GIT_CLONE_ABSOLUTE_DIR,
        "./backup",
        repoType,
        `./${commit.substr(0, 7)}${suffix ? ("-" + suffix) : ""}`,
    );
}

export function formatStreamChunk( // eslint-disable-line @typescript-eslint/explicit-module-boundary-types
    chunk: any, // eslint-disable-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
): string {
    return Buffer.from(chunk, "utf-8").toString();
}

export async function execShell(
    [command, args, options]: Parameters<typeof spawnAsync>,
    {
        printStd = true,
        printEnvWhitelist = [],
        doNotRethrow = false,
    }: {
        printStd?: boolean;
        printEnvWhitelist?: readonly string[];
        doNotRethrow?: boolean
    } = {},
): Promise<Unpacked<ReturnType<typeof spawnAsync>>> {
    {
        const stringifiedOptions = JSON.stringify({
            ...(options && omit({...options}, ["env"])),
            ...{
                whitelistedEnv: options?.env && printEnvWhitelist?.length
                    ? pick(options.env, [...printEnvWhitelist])
                    : undefined,
            },
        });
        const optionsPart = stringifiedOptions !== "{}"
            ? ` (options: ${stringifiedOptions})`
            : "";
        CONSOLE_LOG(
            `Executing Shell command${optionsPart}: ${[command, ...(args ?? [])].join(" ")}`,
        );
    }

    const spawnPromise = spawnAsync(command, args, options);

    if (printStd) {
        const {stdout, stderr} = spawnPromise.child;
        if (stdout) {
            byline(stdout).on("data", (chunk) => CONSOLE_LOG(formatStreamChunk(chunk)));
        }
        if (stderr) {
            byline(stderr).on("data", (chunk) => CONSOLE_LOG(formatStreamChunk(chunk)));
        }
    }

    try {
        return await spawnPromise;
    } catch (_) {
        const error = _ as Unpacked<ReturnType<typeof spawnAsync>>;
        if (doNotRethrow) {
            return error;
        }
        (() => {
            const omitProps: Array<keyof typeof error> = ["output", "stderr", "stdout"];
            omitProps.forEach((omitProp) => {
                if (omitProp in error) {
                    delete error[omitProp]; // eslint-disable-line @typescript-eslint/no-unsafe-member-access
                }
            });
        })();
        throw error;
    }
}

export async function fetchUrl(...[url, options]: Parameters<typeof fetch>): ReturnType<typeof fetch> {
    CONSOLE_LOG(`Downloading ${url}`);
    const response = await fetch(url, options);
    if (!response.ok) {
        throw new Error(`Downloading failed: ${JSON.stringify(pick(response, ["status", "statusText"]))}`);
    }
    return response;
}

export async function resolveGitCommitInfo(
    {dir}: { dir: string },
): Promise<{ shortCommit: string, commit: string }> {
    return (
        await Promise.all(
            (
                [
                    {prop: "shortCommit", gitArgs: ["rev-parse", "--short", "HEAD"]},
                    {prop: "commit", gitArgs: ["rev-parse", "HEAD"]},
                ] as const
            ).map(
                async ({gitArgs, prop}) => execShell(["git", gitArgs, {cwd: dir}])
                    .then(({stdout}) => ({value: stdout.replace(/(\r\n|\n|\r)/gm, ""), gitArgs, prop})),
            ),
        )
    ).reduce(
        (accumulator: NoExtraProps<Record<typeof prop, string>>, {value, gitArgs, prop}) => {
            if (!value) {
                throw new Error(`"${JSON.stringify(gitArgs)}" git command returned empty value: ${value}`);
            }
            return {...accumulator, [prop]: value};
        },
        {shortCommit: "", commit: ""},
    );
}

export const calculateHash = async (
    filePath: string,
    algorithm = "sha256",
): Promise<{ hash: string; type: typeof algorithm }> => {
    return new Promise((resolve, reject) => {
        const hash = createHash(algorithm);

        fs.createReadStream(filePath)
            .on("data", (data) => hash.update(data))
            .on("end", () => resolve({hash: hash.digest("hex"), type: algorithm}))
            .on("error", reject);
    });
};

export const resolveExecutable = async (
    url: string,
    sha256: string,
    subdirectory: string,
    options?: { optionalHashSumCheck: boolean },
): Promise<{ command: string }> => {
    const destFile = path.join(
        OUTPUT_ABSOLUTE_DIR,
        "./executables",
        subdirectory,
        (() => {
            const fileName = new URL(url).pathname.split("/").pop();
            if (!fileName) {
                throw new Error(`Failed to parse executable file name from the "${url}"`);
            }
            return fileName;

        })(),
    );
    const calculateHashes = async (): Promise<{ actual: string, expected: string, equal: boolean }> => {
        const actual = (await calculateHash(destFile)).hash;
        const expected = sha256;
        const result = {actual, expected, equal: actual === expected} as const;
        CONSOLE_LOG(`Calculated "${destFile}" checksum: ${JSON.stringify(result)}`);
        return result;
    };

    if (
        !await fsExtra.pathExists(destFile)
        ||
        !(await calculateHashes()).equal
    ) {
        const response = await fetchUrl(url);
        fsExtra.ensureDirSync(path.dirname(destFile));
        await promisify(fs.writeFile)(destFile, await response.buffer());
    }

    {
        const hashes = await calculateHashes();
        if (!hashes.equal) {
            const message = `Hashes verification failed: ${JSON.stringify(hashes)}`;
            if (!options?.optionalHashSumCheck) {
                throw new Error(message);
            }
            CONSOLE_LOG(message);
        }
    }

    if (os.platform() !== "win32") {
        await execShell(["chmod", ["+x", destFile]]);
    }

    return {command: destFile};
};

export const catchTopLeventAsync = (asyncFn: () => Promise<unknown>): void => {
    (async () => {
        await asyncFn();
    })().catch((error) => {
        CONSOLE_LOG(error);
        process.exit(1);
    });
};

export const applyPatch = async ({patchFile, cwd}: { patchFile: string; cwd: string }): Promise<void> => {
    await execShell([
        "git",
        [
            "apply",
            "--ignore-whitespace",
            "--reject",
            patchFile,
        ],
        {cwd},
    ]);
};
