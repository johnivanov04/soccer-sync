// src/firestoreSafe.ts
import { onSnapshot } from "firebase/firestore";

function isPermDenied(err: any) {
  const code = String(err?.code ?? "");
  const msg = String(err?.message ?? "");
  return code.includes("permission-denied") || msg.toLowerCase().includes("permission");
}

type SnapshotSafeOptions = {
  label?: string;
  onError?: (err: any) => void;
  onPermissionDenied?: (err: any) => void;
};

export function onSnapshotSafe(
  refOrQuery: any,
  next: (snap: any) => void,
  labelOrOptions?: string | SnapshotSafeOptions
) {
  const opts: SnapshotSafeOptions =
    typeof labelOrOptions === "string" ? { label: labelOrOptions } : labelOrOptions ?? {};

  return onSnapshot(refOrQuery, {
    next,
    error: (err) => {
      if (isPermDenied(err)) {
        opts.onPermissionDenied?.(err);
        return;
      }
      if (opts.onError) {
        opts.onError(err);
        return;
      }
      console.warn(`${opts.label ?? "snapshot"} error:`, err);
    },
  });
}
