import {gridLayout as tttGridLayout} from '../src/screens/missions/TicTacToeGame';

/**
 * ViewStyle's width/height/borderWidth are `DimensionValue | undefined` (number, percent
 * string, or unset). The grids under test are always laid out in plain numeric dp — a
 * percentage or unset dimension here would itself be a layout change worth failing loudly on,
 * not something to silently coerce.
 */
function asNumber(value: unknown, label: string): number {
  if (typeof value !== 'number') {
    throw new Error(
      `expected ${label} to be a plain number, got ${String(value)}`,
    );
  }
  return value;
}

describe('TicTacToe grid layout', () => {
  // Fixed game shape: a 3x3 board. Not derived from tttTurn.ts's board length here — see
  // ALL_IS_FIXED #40's plan for why exporting the real style beat exporting a parallel constant.
  const perRow = 3;

  it('cells fit the grid content box exactly (width)', () => {
    const {grid, cell} = tttGridLayout;
    const contentWidth =
      asNumber(grid.width, 'grid.width') -
      2 * asNumber(grid.borderWidth ?? 0, 'grid.borderWidth');
    expect(perRow * asNumber(cell.width, 'cell.width')).toBeLessThanOrEqual(
      contentWidth,
    );
  });

  it('cells fit the grid content box exactly (height)', () => {
    const {grid, cell} = tttGridLayout;
    const contentHeight =
      asNumber(grid.height, 'grid.height') -
      2 * asNumber(grid.borderWidth ?? 0, 'grid.borderWidth');
    expect(perRow * asNumber(cell.height, 'cell.height')).toBeLessThanOrEqual(
      contentHeight,
    );
  });

  // Border is the only spacing key folded into the arithmetic above. Padding on the
  // container or margin on the cell would shrink/grow the same content box and silently
  // reintroduce the wrap bug while the assertions above stayed green — so guard their
  // absence explicitly rather than trying to fold every spacing key into the arithmetic.
  it('has no padding on the grid or margin on the cell that the arithmetic above ignores', () => {
    const {grid, cell} = tttGridLayout;
    expect(grid.padding).toBeUndefined();
    expect(grid.paddingHorizontal).toBeUndefined();
    expect(grid.paddingVertical).toBeUndefined();
    expect(cell.margin).toBeUndefined();
    expect(cell.marginHorizontal).toBeUndefined();
    expect(cell.marginVertical).toBeUndefined();
  });
});
