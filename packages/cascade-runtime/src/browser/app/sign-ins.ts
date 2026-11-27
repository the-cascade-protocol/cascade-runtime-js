// The browser app's part of a sign-in at a hospital: the person signs in in a popup, which the app opens in the click that
// asked for it, since a browser blocks `window.open` once that click is over.
import type { Hospitals } from "../../app/pod-api.js";
import { popupSignIn } from "../sign-in.js";

/**
 * The popup a sign-in uses. `open()` is called in the person's click and gives what closes the popup again; the next
 * `signIn(row, { pod }, report)` takes the popup that was opened, signs in in it and closes it when it is done. A demo
 * hospital's page is told the pod's name as `login_hint`, so it can preselect the patient the pod is for.
 */
export function popupSignIns(): {
  open(): () => void;
  /** Closes the popup that was opened and not yet used by a sign-in. */
  close(): void;
  signIn: Hospitals["signIn"];
} {
  let popup: Window | null | undefined;
  return {
    open() {
      const opened = window.open(
        "",
        "cascade-sign-in",
        "popup,width=520,height=720",
      );
      popup = opened;
      return () => {
        opened?.close();
        if (popup === opened) popup = undefined;
      };
    },
    close() {
      popup?.close();
      popup = undefined;
    },
    signIn(row, { pod }, report) {
      const signing = popup;
      popup = undefined;
      return (authorize, signal) => {
        if (row.vendor === "demo")
          authorize.searchParams.set("login_hint", pod);
        report(authorize.href);
        return popupSignIn({ popup: signing })(authorize, signal).finally(() =>
          signing?.close(),
        );
      };
    },
  };
}
