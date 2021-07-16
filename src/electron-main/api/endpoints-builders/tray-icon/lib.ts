import {NativeImage, nativeImage} from "electron";
import {PassThrough} from "stream";
import {createReadStream} from "fs";
import {hslToRgb, rgbToHsl, toHsl} from "color-fns";
import {lanczos} from "@rgba-image/lanczos";

import {Bitmap} from "pureimage/types/bitmap";
import {CircleConfig, ImageBundle} from "./model";
import {PLATFORM} from "src/electron-main/constants";
import {decodePNGFromStream, encodePNGToStream, make, registerFont} from "pureimage";

// TODO explore https://github.com/vonderheide/mono-bitmap as a potential "pureimage" replacement

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const pureimageUInt32: Readonly<{
    getBytesBigEndian(
        rgba: ReturnType<Bitmap["getPixelRGBA"]>,
    ): readonly [number, number, number, number]; // rgba
    fromBytesBigEndian(
        ...args: ReturnType<typeof pureimageUInt32["getBytesBigEndian"]> // eslint-disable-line  @typescript-eslint/no-use-before-define
    ): ReturnType<Bitmap["getPixelRGBA"]>;
    // TODO TS: import "pureimage/src/uint32" using ES import syntax
}> = require("pureimage/src/uint32"); // eslint-disable-line @typescript-eslint/no-var-requires

const buildCircle: (rad: number, color: string) => Bitmap = (rad, color) => {
    const bitmap = make(rad * 2, rad * 2, null);
    const ctx = bitmap.getContext();

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(bitmap.width - rad, bitmap.height - rad, rad, 0, Math.PI * 2, false);
    ctx.closePath();
    ctx.fill();

    return bitmap;
};

const skipSettingTransparentPixels: (bitmap: Bitmap) => void = (bitmap) => {
    const setPixelRGBAOriginal = bitmap.setPixelRGBA.bind(bitmap);
    const setPixelRGBAOverridden: typeof setPixelRGBAOriginal = function(this: typeof bitmap, x: number, y: number, rgba: number) {
        if (rgba === 0) {
            return;
        }
        return setPixelRGBAOriginal.call(this, x, y, rgba);
    };
    bitmap.setPixelRGBA = setPixelRGBAOverridden;
};

const encodePNGToBuffer: (input: Bitmap) => Promise<Buffer> = async (input) => {
    return new Promise<Buffer>((resolve, reject) => {
        const stream = new PassThrough();
        const data: number[] = [];

        stream
            .on("data", (chunk: typeof data) => data.push(...chunk))
            .on("error", (error) => reject(error))
            .on("end", () => {
                encodingPromise // eslint-disable-line @typescript-eslint/no-use-before-define
                    .then(() => resolve(Buffer.from(data)))
                    .catch(reject);
            });

        const encodingPromise = encodePNGToStream(input, stream);
    });
};

const cloneBitmap: (input: Pick<Bitmap, "width" | "height" | "data">) => Bitmap = (input) => {
    const output = make(input.width, input.height, null);

    output.data = Buffer.from(input.data);

    return output;
};

const bitmapToNativeImage: (source: Bitmap) => Promise<NativeImage> = (
    (): typeof bitmapToNativeImage => {
        const darwinSize = Object.freeze({width: 16, height: 16}); // macOS uses 16x16 tray icon
        const platformSpecificScale: (source: Bitmap) => Promise<Bitmap> = PLATFORM === "darwin"
            ? async (source): ReturnType<typeof platformSpecificScale> => {
                const sourceBits = source.data.byteLength / (source.width * source.height);
                const dest = {
                    data: Uint8ClampedArray.from(new Array(darwinSize.width * darwinSize.height * sourceBits)),
                    ...darwinSize,
                };

                lanczos(
                    {
                        data: new Uint8ClampedArray(source.data),
                        width: source.width,
                        height: source.height,
                    },
                    dest,
                );

                const result = make(dest.width, dest.height, null);

                result.data = Buffer.from(dest.data);

                return result;
            }
            : async (source): ReturnType<typeof platformSpecificScale> => source;
        const resultFn: typeof bitmapToNativeImage = async (source: Bitmap): Promise<NativeImage> => {
            return nativeImage.createFromBuffer(
                await encodePNGToBuffer(
                    await platformSpecificScale(source),
                ),
            );
        };
        return resultFn;
    }
)();

export async function recolor(
    {source, fromColor, toColor}: Readonly<{ source: Bitmap; fromColor: string; toColor: string }>,
): Promise<ImageBundle> {
    const hslColors = {
        from: toHsl(fromColor),
        to: toHsl(toColor),
    } as const;
    if (!hslColors.from || !hslColors.to) {
        throw new Error(`Failed to parse some of the Hex colors: ${JSON.stringify({from: fromColor, toColor})}`);
    }

    const hslColorShift = {
        hue: hslColors.to.hue - hslColors.from.hue,
        sat: hslColors.to.sat - hslColors.from.sat,
        lum: hslColors.to.lum - hslColors.from.lum,
    } as const;

    const bitmap = cloneBitmap(source);

    for (let x = 0; x < bitmap.width; x++) {
        for (let y = 0; y < bitmap.height; y++) {
            const [red, green, blue, alpha] = pureimageUInt32.getBytesBigEndian(
                bitmap.getPixelRGBA(x, y),
            );

            // skip transparent / semi-transparent pixels
            if (alpha < 10) {
                continue;
            }

            const hsl = rgbToHsl({red, green, blue});
            if (!hsl) {
                throw new Error(`Failed to form HSL value from RGB color: ${JSON.stringify({red, green, blue})}`);
            }

            const newHsl = {
                hue: hsl.hue + hslColorShift.hue,
                sat: hsl.sat + hslColorShift.sat,
                lum: hsl.lum + hslColorShift.lum,
            } as const;

            const newRgb = hslToRgb(newHsl);
            if (!newRgb) {
                throw new Error(`Failed to form RGB value from HSL color: ${JSON.stringify(newHsl)}`);
            }

            bitmap.setPixelRGBA(
                x,
                y,
                pureimageUInt32.fromBytesBigEndian(
                    newRgb.red,
                    newRgb.green,
                    newRgb.blue,
                    alpha,
                ),
            );
        }
    }

    return {
        bitmap,
        native: await bitmapToNativeImage(bitmap),
    };
}

export async function trayIconBundleFromPath(trayIconPath: string): Promise<ImageBundle> {
    const bitmap = await decodePNGFromStream(createReadStream(trayIconPath));

    return {
        bitmap,
        native: await bitmapToNativeImage(bitmap),
    };
}

export async function loggedOutBundle({bitmap: source}: ImageBundle, config: CircleConfig): Promise<ImageBundle> {
    const rad = (source.width * config.scale) / 2;
    const circle = buildCircle(rad, config.color);
    const {width, height} = circle;
    const bitmap = cloneBitmap(source);

    skipSettingTransparentPixels(bitmap);
    bitmap.getContext().drawImage(circle, 0, 0, width, height, 0, 0, width, height);

    return {
        bitmap,
        native: await bitmapToNativeImage(bitmap),
    };
}

export async function unreadNative(
    unread: number,
    fontFilePath: string,
    {bitmap: source}: ImageBundle,
    config: CircleConfig & { textColor: string },
): Promise<{
    icon: NativeImage;
    overlay: NativeImage;
}> {
    const circle = await (async (text, fontFamily): Promise<ReturnType<typeof buildCircle>> => {
        const rad = (source.width * config.scale) / 2;
        const textDrawArea = buildCircle(rad, config.color);

        if (!text || text.length > 2) {
            text = "+";
        }

        const scale = text.length === 1 ? 1.6 : 1.35;
        const size = rad * scale;
        const x = size - rad * 1.1;
        const y = size + rad * scale * (text.length - 1) * .1;
        const ctx = textDrawArea.getContext();

        await new Promise<ReturnType<(typeof registerFont)>>((resolve) => {
            const fontRecord = registerFont(
                fontFilePath,
                fontFamily,
                // TODO TS drop "pureimage" type casting on "registerFont" call
                undefined as unknown as number,
                undefined as unknown as string,
                undefined as unknown as string,
            );
            fontRecord.load(() => resolve(fontRecord));
        });

        // TODO TS drop "pureimage" type casting on assigning "context.font"
        ctx.font = `${size}pt ${fontFamily}` as unknown as typeof ctx.font;
        ctx.fillStyle = config.textColor;
        ctx.fillText(text, x, y);

        return textDrawArea;
    })(String(unread), "some-font-family");
    const {width, height} = circle;
    const icon = cloneBitmap(source);

    skipSettingTransparentPixels(icon);

    icon
        .getContext()
        .drawImage(circle, 0, 0, width, height, icon.width - width, icon.height - height, width, height);

    return {
        icon: await bitmapToNativeImage(icon),
        overlay: await bitmapToNativeImage(circle),
    };
}
