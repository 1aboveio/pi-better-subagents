/**
 * TypeScript re-export of navigator.mjs pure seams.
 * Logic lives in navigator.mjs for ESM unit-test compatibility (mirrors widget.ts).
 */
export {
    NAVIGATOR_STATUS_KEY,
    DETAIL_TICK_MS,
    navigatorFooterHint,
    applyNavigatorFooter,
    isNavigatorUiAvailable,
    buildNavigatorRows,
    buildNavigatorDetail,
    buildDetailLines,
    createNavigatorState,
    clampSelection,
    moveSelection,
    selectById,
    buildNavigatorLines,
    createNavigatorOverlayComponent,
    createNavigatorOverlayFactory,
    showNavigator,
    openTrackedNavigator,
    disposeTrackedNavigator,
    wrapEditor,
    NAVIGATOR_FACTORY_MARK,
    installNavigatorEditor,
} from "./navigator.mjs";
