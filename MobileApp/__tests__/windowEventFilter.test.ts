import {
  createWindowEventFilter,
  isImePackage,
  LAUNCHER_SETTLE_MS,
} from '../src/capture/windowEventFilter';

function makeFilter() {
  const clock = {t: 0};
  const filter = createWindowEventFilter({now: () => clock.t});
  return {clock, filter};
}

describe('isImePackage', () => {
  it('matches the observed Gboard package by exact name', () => {
    expect(isImePackage('com.google.android.inputmethod.latin')).toBe(true);
  });

  it('matches other IMEs by substring', () => {
    expect(isImePackage('com.touchtype.swiftkey')).toBe(true);
    expect(isImePackage('com.samsung.android.honeyboard.ime')).toBe(true);
    expect(isImePackage('com.some.oem.inputmethod.service')).toBe(true);
  });

  it('does not match ordinary app packages', () => {
    expect(isImePackage('com.android.chrome')).toBe(false);
    expect(isImePackage('com.instagram.android')).toBe(false);
    expect(isImePackage('')).toBe(false);
  });
});

describe('windowEventFilter', () => {
  it('rejects the app own package', () => {
    const {filter} = makeFilter();
    expect(filter.accept('com.mobileapp')).toEqual({
      accept: false,
      reason: 'OWN_PACKAGE',
    });
  });

  it('rejects IME packages, including com.google.android.inputmethod.latin', () => {
    const {filter} = makeFilter();
    expect(filter.accept('com.google.android.inputmethod.latin')).toEqual({
      accept: false,
      reason: 'IME',
    });
    expect(filter.accept('com.touchtype.swiftkey')).toEqual({
      accept: false,
      reason: 'IME',
    });
  });

  it('rejects a repeat of the last accepted package', () => {
    const {filter} = makeFilter();
    expect(filter.accept('com.android.chrome').accept).toBe(true);
    expect(filter.accept('com.android.chrome')).toEqual({
      accept: false,
      reason: 'SAME_PACKAGE',
    });
  });

  it('collapses the observed com.miui.home -> googlequicksearchbox -> com.miui.home flap to one accept', () => {
    const {clock, filter} = makeFilter();

    clock.t = 0;
    const first = filter.accept('com.miui.home');

    clock.t = 500;
    const second = filter.accept('com.google.android.googlequicksearchbox');

    clock.t = 1_000;
    const third = filter.accept('com.miui.home');

    const accepts = [first, second, third].filter(d => d.accept);
    expect(accepts).toHaveLength(1);
    expect(first).toEqual({accept: true});
    expect(second).toEqual({accept: false, reason: 'LAUNCHER_SETTLING'});
    expect(third).toEqual({accept: false, reason: 'SAME_PACKAGE'});
  });

  it('accepts a genuine com.miui.home -> com.android.chrome switch once the settle window has passed', () => {
    const {clock, filter} = makeFilter();

    clock.t = 0;
    expect(filter.accept('com.miui.home')).toEqual({accept: true});

    clock.t = LAUNCHER_SETTLE_MS + 500; // 2000ms — past the 1500ms settle window
    expect(filter.accept('com.android.chrome')).toEqual({accept: true});
  });

  it('accepts a switch to a non-launcher app immediately when the previous package was not a launcher', () => {
    const {clock, filter} = makeFilter();

    clock.t = 0;
    expect(filter.accept('com.android.chrome')).toEqual({accept: true});

    clock.t = 100;
    expect(filter.accept('com.instagram.android')).toEqual({accept: true});
  });

  it('reset() clears state so a repeat of the previously accepted package is accepted again', () => {
    const {filter} = makeFilter();

    expect(filter.accept('com.android.chrome')).toEqual({accept: true});
    expect(filter.getLastAcceptedPackage()).toBe('com.android.chrome');

    filter.reset();
    expect(filter.getLastAcceptedPackage()).toBeNull();

    expect(filter.accept('com.android.chrome')).toEqual({accept: true});
  });
});
