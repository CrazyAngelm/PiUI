import { legacyRu } from './legacyRu';
import { featureRu } from './ru';
import { russianUi } from './russianUi';
import { shellRu } from './shellRu';

/** Russian UI copy, loaded on demand; conversation text is never translated. */
export function lookupRussian(value: string): string | undefined {
  return russianUi[value] ?? shellRu[value] ?? featureRu[value] ?? legacyRu[value];
}
