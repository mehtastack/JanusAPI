/** jsdom has no PointerEvent; a MouseEvent with a pointer id is enough for drag tests. Import before firing pointer events. */
if (typeof window !== 'undefined' && typeof window.PointerEvent === 'undefined') {
  class MockPointerEvent extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  }
  Object.assign(window, { PointerEvent: MockPointerEvent });
  Object.assign(globalThis, { PointerEvent: MockPointerEvent });
}
export {};
