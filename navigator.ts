/**
 * TypeScript re-export of navigator.mjs pure seams.
 * Logic lives in navigator.mjs for ESM unit-test compatibility (mirrors widget.ts).
 */
export {
    NAVIGATOR_STATUS_KEY,
    navigatorFooterHint,
    applyNavigatorFooter,
    isNavigatorUiAvailable,
    buildNavigatorRows,
    createNavigatorState,
    clampSelection,
    moveSelection,
    buildNavigatorLines,
    createNavigatorOverlayComponent,
    createNavigatorOverlayFactory,
    showNavigator,
    wrapEditor,
    NAVIGATOR_FACTORY_MARK,
    installNavigatorEditor,
} from "./navigator.mjs";
