import {Bitmap} from "pureimage/types/bitmap";
import {NativeImage} from "electron";

export interface CircleConfig {
    readonly scale: number;
    readonly color: string;
}

export interface ImageBundle {
    readonly bitmap: Bitmap;
    readonly native: NativeImage;
}
