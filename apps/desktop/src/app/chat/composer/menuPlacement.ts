/**
 * Where the composer's menu opens and how tall it may be (pure, no DOM). It
 * opens above the field; when that side is too short to show a few rows, as in
 * a new chat near the top of the window, it opens below. Whatever does not fit
 * scrolls inside the menu.
 */
export interface MenuRoom {
  /** Free pixels between the field and the nearest clipping edge above it. */
  readonly above: number;
  /** The same below the field. */
  readonly below: number;
}

export interface MenuPlacement {
  readonly side: 'above' | 'below';
  readonly height: number;
}

/** The tallest the menu grows and the shortest side that is still worth opening on. */
export const MENU_MAX_HEIGHT = 360;
export const MENU_MIN_HEIGHT = 150;
/** About one row: below this much room the menu stays this tall rather than vanish. */
const MENU_FLOOR = 48;

export function menuPlacement(room: MenuRoom, wanted: number = MENU_MAX_HEIGHT): MenuPlacement {
  const above = Math.max(0, Math.floor(room.above));
  const below = Math.max(0, Math.floor(room.below));
  const enough = Math.min(wanted, MENU_MIN_HEIGHT);
  const side = above >= enough || above >= below ? 'above' : 'below';
  const space = side === 'above' ? above : below;
  return { side, height: Math.max(MENU_FLOOR, Math.min(wanted, space)) };
}
