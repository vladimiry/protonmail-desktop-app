import UUID from "pure-uuid";
import {Actions, createEffect, ofType} from "@ngrx/effects";
import {EMPTY, forkJoin, from, merge, of} from "rxjs";
import {Injectable, NgZone} from "@angular/core";
import {Store, select} from "@ngrx/store";
import {concatMap, filter, finalize, map, mergeMap, switchMap, takeUntil, tap, throttleTime, withLatestFrom} from "rxjs/operators";
import {omit, pick} from "remeda";

import {ACCOUNTS_ACTIONS, DB_VIEW_ACTIONS, OPTIONS_ACTIONS} from "src/web/browser-window/app/store/actions";
import {ElectronService} from "src/web/browser-window/app/_core/electron.service";
import {IPC_MAIN_API_NOTIFICATION_ACTIONS} from "src/shared/api/main-process/actions";
import {ONE_SECOND_MS} from "src/shared/constants";
import {OptionsSelectors} from "src/web/browser-window/app/store/selectors";
import {State} from "src/web/browser-window/app/store/reducers/db-view";
import {curryFunctionMembers} from "src/shared/util";
import {getWebLogger} from "src/web/browser-window/util";

const _logger = getWebLogger(__filename);

@Injectable()
export class DbViewEffects {
    readonly ipcMainClient = this.api.ipcMainClient();

    mountInstance$ = createEffect(
        () => this.actions$.pipe(
            ofType(DB_VIEW_ACTIONS.MountInstance),
            mergeMap(({payload: {finishPromise, webAccountPk}, ...action}) => {
                const logger = curryFunctionMembers(_logger, `[${action.type}][${webAccountPk.accountIndex}]`);
                const dispose$ = from(finishPromise).pipe(tap(() => logger.info("dispose")));
                const ipcMainClient = this.api.ipcMainClient({finishPromise, serialization: "msgpackr"});

                logger.info("setup");

                return merge(
                    // data load (initial)
                    from(ipcMainClient("dbGetAccountDataView")(webAccountPk)),
                    // data load (on change in the main process)
                    this.store.pipe(
                        select(OptionsSelectors.FEATURED.mainProcessNotification),
                        ofType(IPC_MAIN_API_NOTIFICATION_ACTIONS.DbPatchAccount),
                        filter(({payload: {key}}) => key.login === webAccountPk.login),
                        filter(({payload: {entitiesModified}}) => entitiesModified),
                        switchMap(() => from(ipcMainClient("dbGetAccountDataView")(webAccountPk))),
                    ),
                    // side notification (status/progress patching)
                    this.store.pipe(
                        select(OptionsSelectors.FEATURED.mainProcessNotification),
                        ofType(IPC_MAIN_API_NOTIFICATION_ACTIONS.DbIndexerProgressState),
                        filter(({payload}) => {
                            return "key" in payload
                                ? payload.key.login === webAccountPk.login
                                : true;
                        }),
                        mergeMap(({payload}) => {
                            this.ngZone.run(() => {
                                this.store.dispatch(
                                    "key" in payload
                                        ? ACCOUNTS_ACTIONS.PatchProgress({login: payload.key.login, patch: payload.status})
                                        : ACCOUNTS_ACTIONS.PatchGlobalProgress({patch: payload.status}),
                                );
                            });
                            return EMPTY;
                        }),
                    ),
                ).pipe(
                    mergeMap((accountDataView) => {
                        if (accountDataView) {
                            this.ngZone.run(() => {
                                this.store.dispatch(
                                    DB_VIEW_ACTIONS.SetFolders({webAccountPk, folders: accountDataView.folders}),
                                );
                            });
                        }

                        return EMPTY;
                    }),
                    takeUntil(dispose$),
                );
            }),
        ),
        {dispatch: false},
    );

    dbExport$ = createEffect(
        () => this.actions$.pipe(
            ofType(DB_VIEW_ACTIONS.DbExport),
            mergeMap(({payload}) => {
                const pk = pick(payload, ["login", "accountIndex"]);
                const uuid = new UUID(4).format();
                return merge(
                    of(ACCOUNTS_ACTIONS.PatchDbExportProgress({pk, uuid, progress: 0})),
                    from(this.api.ipcMainClient()("dbExport")(payload)).pipe(
                        mergeMap((value) => "progress" in value ? [value] : []),
                        throttleTime(ONE_SECOND_MS / 4),
                        mergeMap(({progress}) => {
                            return of(ACCOUNTS_ACTIONS.PatchDbExportProgress({pk, uuid, progress}));
                        }),
                        finalize(() => {
                            this.store.dispatch(ACCOUNTS_ACTIONS.PatchDbExportProgress({pk, uuid}));
                        }),
                    ),
                );
            }),
        ),
    );

    selectMailRequest$ = createEffect(
        () => this.actions$.pipe(
            ofType(DB_VIEW_ACTIONS.SelectMailRequest),
            mergeMap(({payload}) => {
                const {webAccountPk, mailPk} = payload;
                const ipcMainClient = this.api.ipcMainClient();

                return forkJoin([
                    from(ipcMainClient("dbGetAccountMail")({...webAccountPk, pk: mailPk})),
                    from(ipcMainClient("dbSearchRootConversationNodes")({...webAccountPk, mailPks: [mailPk]})).pipe(
                        map((rootNodes) => {
                            if (rootNodes.length !== 1) {
                                throw new Error(`Failed to resolve mail's root conversation node`);
                            }
                            return rootNodes[0];
                        }),
                    ),
                ]).pipe(
                    mergeMap(([mail, rootNode]) => {
                        if (!rootNode) {
                            throw new Error("Invalid root node value");
                        }
                        return of(DB_VIEW_ACTIONS.SelectMail({
                            webAccountPk,
                            value: {
                                rootNode,
                                listMailPk: mail.pk,
                                conversationMail: mail,
                            },
                        }));
                    }),
                );
            }),
        ),
    );

    selectConversationMailRequest$ = createEffect(
        () => this.actions$.pipe(
            ofType(DB_VIEW_ACTIONS.SelectConversationMailRequest),
            mergeMap(({payload: {webAccountPk, mailPk}}) => {
                return from(
                    this.api.ipcMainClient()("dbGetAccountMail")({...webAccountPk, pk: mailPk}),
                ).pipe(
                    mergeMap((conversationMail) => of(DB_VIEW_ACTIONS.SelectConversationMail({webAccountPk, conversationMail}))),
                );
            }),
        ),
    );

    fullTextSearchRequest$ = createEffect(
        () => this.actions$.pipe(
            ofType(DB_VIEW_ACTIONS.FullTextSearchRequest),
            withLatestFrom(this.store.pipe(select(OptionsSelectors.CONFIG.timeouts))),
            mergeMap(([{payload}, {fullTextSearch: fullTextSearchTimeoutMs}]) => {
                const webAccountPk = pick(payload, ["login", "accountIndex"]);
                return merge(
                    of(ACCOUNTS_ACTIONS.PatchProgress({login: payload.login, patch: {searching: true}})),
                    from(
                        this.api.ipcMainClient()(
                            "dbFullTextSearch",
                            {
                                // "fullTextSearchTimeoutMs" is the full-text search only specific value
                                // so adding reserve for "second step of the search" (by folders/data/js-code/etc), result serialization/etc
                                // TODO introduce addition timeout for the "second step of the search"
                                timeoutMs: payload.codeFilter
                                    ? fullTextSearchTimeoutMs * 5
                                    : fullTextSearchTimeoutMs * 1.2,
                                serialization: "msgpackr",
                            },
                        )(omit({...payload}, ["accountIndex"])),
                    ).pipe(
                        mergeMap((value) => [
                            DB_VIEW_ACTIONS.SelectMail({webAccountPk}),
                            DB_VIEW_ACTIONS.FullTextSearch({webAccountPk, value}),
                        ]),
                        finalize(() => {
                            this.store.dispatch(ACCOUNTS_ACTIONS.PatchProgress({login: payload.login, patch: {searching: false}}));
                        }),
                    ),
                );
            }),
        ),
    );

    toggleLocalDbMailsListViewMode$ = createEffect(
        () => this.actions$.pipe(
            ofType(OPTIONS_ACTIONS.ToggleLocalDbMailsListViewMode),
            concatMap(() => {
                return merge(
                    of(OPTIONS_ACTIONS.PatchProgress({togglingLocalDbMailsListViewMode: true})),
                    from(
                        this.ipcMainClient("toggleLocalDbMailsListViewMode")(),
                    ).pipe(
                        concatMap((config) => [
                            OPTIONS_ACTIONS.GetConfigResponse(config),
                        ]),
                        finalize(() => {
                            this.store.dispatch(OPTIONS_ACTIONS.PatchProgress({togglingLocalDbMailsListViewMode: false}));
                        }),
                    ),
                );
            }),
        ),
    );

    constructor(
        private api: ElectronService,
        private store: Store<State>,
        private ngZone: NgZone,
        private readonly actions$: Actions,
    ) {}
}
