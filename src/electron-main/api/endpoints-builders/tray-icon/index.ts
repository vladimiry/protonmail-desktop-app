import {app} from "electron";

import {CircleConfig, ImageBundle} from "./model";
import {Context} from "src/electron-main/model";
import {DEFAULT_TRAY_ICON_COLOR, DEFAULT_UNREAD_BADGE_BG_COLOR, DEFAULT_UNREAD_BADGE_BG_TEXT} from "src/shared/constants";
import {IPC_MAIN_API_NOTIFICATION$} from "src/electron-main/api/constants";
import {IPC_MAIN_API_NOTIFICATION_ACTIONS} from "src/shared/api/main-process/actions";
import {IpcMainApiEndpoints} from "src/shared/api/main-process";
import {loggedOutBundle, recolor, trayIconBundleFromPath, unreadNative} from "./lib";

const config: DeepReadonly<{
    loggedOut: CircleConfig;
    unread: CircleConfig & { textColor: string };
}> = {
    loggedOut: {scale: .25, color: "#F9C83E"},
    unread: {scale: .75, color: DEFAULT_UNREAD_BADGE_BG_COLOR, textColor: DEFAULT_UNREAD_BADGE_BG_TEXT},
};

const resolveState: (ctx: DeepReadonly<Context>) => Promise<{
    readonly fileIcon: ImageBundle;
    trayIconColor: string;
    defaultIcon: ImageBundle;
    loggedOutIcon: ImageBundle;
}> = (() => {
    let state: Unpacked<ReturnType<typeof resolveState>> | undefined;

    const resultFn: typeof resolveState = async (ctx: DeepReadonly<Context>) => {
        if (state) {
            return state;
        }

        const fileIcon = await trayIconBundleFromPath(ctx.locations.trayIcon);
        const defaultIcon = fileIcon;
        const loggedOutIcon = await loggedOutBundle(defaultIcon, config.loggedOut);

        state = {
            trayIconColor: DEFAULT_TRAY_ICON_COLOR,
            fileIcon,
            defaultIcon,
            loggedOutIcon,
        };

        return state;
    };

    return resultFn;
})();

export async function buildEndpoints(
    ctx: DeepReadonly<Context>,
): Promise<Pick<IpcMainApiEndpoints, "updateOverlayIcon">> {
    return {
        // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
        async updateOverlayIcon({hasLoggedOut, unread, unreadBgColor, unreadTextColor, trayIconColor}) {
            const {browserWindow, tray} = (ctx.uiContext && await ctx.uiContext) ?? {};

            if (!browserWindow || !tray) {
                return;
            }

            const state = await resolveState(ctx);

            if (trayIconColor && state.trayIconColor !== trayIconColor) {
                state.defaultIcon = await recolor({
                    source: state.fileIcon.bitmap,
                    fromColor: DEFAULT_TRAY_ICON_COLOR,
                    toColor: trayIconColor,
                });
                state.loggedOutIcon = await loggedOutBundle(state.defaultIcon, config.loggedOut);
                state.trayIconColor = trayIconColor;
            }

            setImmediate(() => {
                IPC_MAIN_API_NOTIFICATION$.next(
                    IPC_MAIN_API_NOTIFICATION_ACTIONS.TrayIconDataURL({value: state.defaultIcon.native.toDataURL()}),
                );
            });

            const canvas = hasLoggedOut
                ? state.loggedOutIcon
                : state.defaultIcon;

            if (unread > 0) {
                const {icon, overlay} = await unreadNative(
                    unread,
                    ctx.locations.trayIconFont,
                    canvas,
                    {
                        ...config.unread,
                        ...(unreadBgColor && {color: unreadBgColor}),
                        ...(unreadTextColor && {textColor: unreadTextColor}),
                    },
                );

                browserWindow.setOverlayIcon(overlay, `Unread messages count: ${unread}`);
                tray.setImage(icon);
                app.badgeCount = unread;
            } else {
                browserWindow.setOverlayIcon(null, "");
                tray.setImage(canvas.native);
                app.badgeCount = 0;
            }
        },
    };
}
