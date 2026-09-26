// Tests read Russian copy synchronously; the app loads it before mounting.
import { loadRussian } from '../features/locale/language';

await loadRussian();
