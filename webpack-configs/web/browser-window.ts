import {AngularWebpackPlugin, AngularWebpackPluginOptions} from "@ngtools/webpack";
import {readConfiguration} from "@angular/compiler-cli";

import {BuildAngularCompilationFlags, BuildEnvVars} from "webpack-configs/model";
import {ENVIRONMENT, rootRelativePath} from "webpack-configs/lib";
import {WEBPACK_WEB_CHUNK_NAMES} from "src/shared/webpack-conts";
import {browserWindowAppPath, browserWindowPath, buildBaseWebConfig, cssRuleSetRules} from "./lib";

const angularCompilationFlags: BuildAngularCompilationFlags = {aot: true, ivy: true};

const tsConfigFile = browserWindowPath(({
    production: "./tsconfig.json",
    development: "./tsconfig.development.json",
    test: "./test/tsconfig.json",
} as Record<BuildEnvVars["BUILD_ENVIRONMENT"], string>)[ENVIRONMENT]);

const config = buildBaseWebConfig(
    {
        module: {
            rules: [
                {
                    test: /\.[jt]sx?$/,
                    loader: "@ngtools/webpack",
                },
                {
                    test: /\.scss$/,
                    use: [
                        "to-string-loader",
                        ...cssRuleSetRules(),
                        "resolve-url-loader",
                        "sass-loader",
                    ],
                    include: [
                        browserWindowAppPath("/"),
                    ],
                },
                {
                    test: require.resolve("monaco-editor/esm/vs/base/common/platform.js"),
                    use: [
                        {
                            loader: "imports-loader",
                            options: {
                                additionalCode: `
                                    const self = {
                                        MonacoEnvironment: {
                                            getWorkerUrl(...[, label]) {
                                                if (label === "typescript" || label === "javascript") {
                                                    return "./monaco-editor.ts.worker.js";
                                                }
                                                return "./monaco-editor.editor.worker.js";
                                            },
                                        },
                                    };
                                `,
                            },
                        },
                    ],
                },
            ],
        },
        resolve: {
            alias: {
                images: rootRelativePath("images"),
                "monaco-editor": rootRelativePath("./node_modules/monaco-editor/esm/vs/editor/editor.main.js"),
            },
        },
        plugins: [
            (() => {
                type StrictTemplateOptions
                    = NoExtraProps<Required<import("@angular/compiler-cli/src/ngtsc/core/api").StrictTemplateOptions>>;
                const strictTemplateOptions: NoExtraProps<Pick<StrictTemplateOptions, "strictTemplates">> = {
                    // if "true", implies all template strictness flags below (unless individually disabled)
                    // see https://angular.io/guide/template-typecheck
                    strictTemplates: angularCompilationFlags.ivy,
                };

                type LegacyNgcOptions
                    = NoExtraProps<Required<Pick<import("@angular/compiler-cli/src/ngtsc/core/api").LegacyNgcOptions,
                    | "fullTemplateTypeCheck"
                    | "strictInjectionParameters">>>;
                const legacyNgcOptions: LegacyNgcOptions = {
                    fullTemplateTypeCheck: angularCompilationFlags.aot || angularCompilationFlags.ivy,
                    strictInjectionParameters: true,
                };

                const compilerOptions: StrictOmit<Required<AngularWebpackPluginOptions>["compilerOptions"],
                    // skipping raw "string" props
                    Extract<keyof Required<AngularWebpackPluginOptions>["compilerOptions"], string>> = {
                    preserveWhitespaces: false,
                    disableTypeScriptVersionCheck: true,
                    enableIvy: angularCompilationFlags.ivy,
                    ...legacyNgcOptions,
                    ...strictTemplateOptions,
                    ...readConfiguration(tsConfigFile).options,
                };

                const angularCompilerPluginOptions: NoExtraProps<AngularWebpackPluginOptions> = {
                    tsconfig: tsConfigFile,
                    compilerOptions,
                    jitMode: !angularCompilationFlags.aot, // renamed from "skipCodeGeneration" since @angular v12
                    directTemplateLoading: false,
                    emitClassMetadata: false,
                    emitNgModuleScope: false,
                    substitutions: {},
                    fileReplacements: {},
                };

                return new AngularWebpackPlugin(angularCompilerPluginOptions);
            })(),
        ],
        optimization: {
            splitChunks: {
                cacheGroups: {
                    defaultVendors: false,
                    vendors: {
                        test: /[\\/]node_modules[\\/]/,
                        priority: -10,
                        filename({chunk}) {
                            if (!chunk?.hash) {
                                throw new Error(`Invalid "chunk.hash" value`);
                            }
                            return `vendor_${chunk.hash}.js`;
                        },
                    },
                    ...Object
                        .entries(
                            {
                                "shared-vendor-dark": "browser-window/vendor/shared-vendor-dark.scss",
                                "shared-vendor-light": "browser-window/vendor/shared-vendor-light.scss",
                                "vendor-dark": "browser-window/vendor/vendor-dark.scss",
                                "vendor-light": "browser-window/vendor/vendor-light.scss",
                                "app-theming-dark": "browser-window/app-theming-dark.scss",
                                "app-theming-light": "browser-window/app-theming-light.scss",
                            } as const,
                        )
                        .reduce(
                            (accumulator, [name, value]) => {
                                return {
                                    ...accumulator,
                                    [`styles-${name}`]: {
                                        // eslint-disable-next-line no-useless-escape
                                        test: new RegExp(`src/web/${value}`.replace(/\//g, "(\|\\\\|/)"), "g"),
                                        name,
                                        chunks: "all",
                                        enforce: true,
                                    },
                                };
                            },
                            {},
                        ),
                },
            },
        },
    },
    {
        tsConfigFile,
        chunkName: WEBPACK_WEB_CHUNK_NAMES["browser-window"],
        entries: {
            "monaco-editor.ts.worker": rootRelativePath("./node_modules/monaco-editor/esm/vs/language/typescript/ts.worker"),
            "monaco-editor.editor.worker": rootRelativePath("./node_modules/monaco-editor/esm/vs/editor/editor.worker.js"),
        },
        htmlWebpackPlugin: {
            // TODO enable resource ordering via the HtmlWebpackPlugin/MiniCssExtractPlugin options (dark/light theming matter)
            inject: false,
        },
    },
);

export default config;
