/**
 * True only in the Nano Web remote bundle (ADR-062), where `host-api/transport`
 * is replaced by a relay to a paired computer. There the shell may call nothing
 * outside `NANO_REMOTE_COMMANDS`: entries that would need another command are
 * hidden, and starters answer their empty state without a host call. On the
 * desktop it is `false` and nothing changes.
 */
export { hostRemote as remoteMode } from '../../host-api/transport';

/** English source copy for an action the remote session refuses before it reaches the host. */
export const REMOTE_UNAVAILABLE_COPY = 'This is not available in a remote session.';
