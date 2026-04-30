const CLICK_TYPES = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"] as const;

export function buildClickDispatcher(functionName = "dispatchClickSequence"): string {
  const typesLiteral = JSON.stringify(CLICK_TYPES);
  return `function ${functionName}(target){
    if(!target || !(target instanceof EventTarget)) return false;
    const rect = typeof target.getBoundingClientRect === 'function'
      ? target.getBoundingClientRect()
      : null;
    const clientX = rect ? rect.left + rect.width / 2 : 0;
    const clientY = rect ? rect.top + rect.height / 2 : 0;
    const types = ${typesLiteral};
    for (const type of types) {
      const isDown = type === 'pointerdown' || type === 'mousedown';
      const common = { bubbles: true, cancelable: true, view: window, clientX, clientY, button: 0, buttons: isDown ? 1 : 0 };
      let event;
      if (type.startsWith('pointer') && 'PointerEvent' in window) {
        event = new PointerEvent(type, { ...common, pointerId: 1, pointerType: 'mouse' });
      } else {
        event = new MouseEvent(type, common);
      }
      target.dispatchEvent(event);
    }
    return true;
  }`;
}
