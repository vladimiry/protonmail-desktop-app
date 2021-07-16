import {ChangeDetectionStrategy, Component, EventEmitter, Input, Output} from "@angular/core";
import {formatDate} from "@angular/common";

import ASSETS_LIST_IMG_URL from "images/assets-list.gif";
import {NotificationItem} from "src/web/browser-window/app/store/actions/notification";

@Component({
    selector: "electron-mail-notification-item",
    templateUrl: "./notification-item.component.html",
    styleUrls: ["./notification-item.component.scss"],
    changeDetection: ChangeDetectionStrategy.OnPush,
    preserveWhitespaces: true,
})
export class NotificationItemComponent {
    readonly assetsListImgUrl = ASSETS_LIST_IMG_URL;

    message = "";

    @Output()
    removeHandler = new EventEmitter<NotificationItem>();

    // TODO move to constructor arg with "@Inject(LOCALE_ID)"
    private locale = "en-US";

    private _item!: NotificationItem;

    @Input()
    set item(item: NotificationItem) {
        this._item = item;
        this.message = item.type === "update"
            ? (
                item.data.newReleaseItems
                    .map(({title, url, date}) => {
                        const hint = `Published at: ${formatDate(date, "medium", this.locale)}`;
                        return url
                            ? `<a href="${url}" title="${hint}">${title}</a>`
                            : `<snap title="${hint}">${title}</snap>`;
                    })
                    .join(", ")
            )
            : item.data.message;
    }

    get item(): NotificationItem {
        return this._item;
    }

    remove(): void {
        this.removeHandler.emit(this._item);
    }
}
