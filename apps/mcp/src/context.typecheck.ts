// Compile-time contract (checked by `tsc --noEmit`, never executed): every transport
// must decide explicitly whether tools may read local files (LBV2-14, fail closed).
import { loadContext } from './context.js';

export function contextContract(): void {
  // @ts-expect-error allowLocalFilePaths is required
  void loadContext({});
  // @ts-expect-error allowLocalFilePaths is required
  void loadContext({ dataDir: '/tmp/x' });
  void loadContext({ allowLocalFilePaths: true });
  void loadContext({ dataDir: '/tmp/x', allowLocalFilePaths: false });
}
