import { useEffect, useRef, type PointerEvent } from "react";

interface SwipeOptions {
  value: string;
  values: readonly string[];
  disabled: boolean;
  onChange: (value: string) => void;
}
interface Gesture {
  id: number;
  x: number;
  y: number;
}

function canStart(target: EventTarget | null, panel: HTMLElement) {
  if (
    !(target instanceof Element) ||
    target.closest(
      'button, input, textarea, select, a, label, summary, dialog, [contenteditable], [role="tablist"], [role="button"], [role="checkbox"], [role="switch"], [role="slider"], [tabindex]:not([tabindex="-1"])',
    )
  )
    return false;
  for (
    let node: Element | null = target;
    node !== panel;
    node = node.parentElement
  ) {
    if (!node) return false;
    if (
      node.scrollWidth > node.clientWidth &&
      ["auto", "scroll"].includes(getComputedStyle(node).overflowX)
    )
      return false;
  }
  return true;
}

export function useTabSwipe(options: SwipeOptions) {
  const panel = useRef<HTMLElement>(null);
  const latest = useRef(options);
  latest.current = options;
  const pen = useRef<Gesture | null>(null);
  const finish = (start: Gesture, x: number, y: number) => {
    const { value, values, disabled, onChange } = latest.current;
    const dx = x - start.x,
      dy = y - start.y;
    if (disabled || Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5)
      return;
    const next = values.indexOf(value) + (dx < 0 ? 1 : -1);
    if (next >= 0 && next < values.length) onChange(values[next]);
  };
  const complete = useRef(finish);
  complete.current = finish;
  useEffect(() => {
    const node = panel.current;
    if (!node) return;
    let gesture: Gesture | null = null;
    const cancel = () => {
      gesture = null;
    };
    const start = (event: TouchEvent) => {
      cancel();
      if (
        latest.current.disabled ||
        event.defaultPrevented ||
        event.touches.length !== 1 ||
        !canStart(event.target, node)
      )
        return;
      const touch = event.touches[0];
      gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY };
    };
    const move = (event: TouchEvent) => {
      if (!gesture) return;
      if (latest.current.disabled || event.touches.length !== 1)
        return cancel();
      const touch = event.touches[0];
      if (touch.identifier !== gesture.id) return cancel();
      const dx = Math.abs(touch.clientX - gesture.x),
        dy = Math.abs(touch.clientY - gesture.y);
      if (dy > 10 && dy > dx) return cancel();
      if (dx > 10 && dx > dy * 1.5) {
        if (!event.cancelable || event.defaultPrevented) return cancel();
        event.preventDefault();
      }
    };
    const end = (event: TouchEvent) => {
      const initial = gesture;
      cancel();
      if (!initial || event.touches.length) return;
      const touch = Array.from(event.changedTouches).find(
        (t) => t.identifier === initial.id,
      );
      if (touch) complete.current(initial, touch.clientX, touch.clientY);
    };
    node.addEventListener("touchstart", start, { passive: true });
    node.addEventListener("touchmove", move, { passive: false });
    node.addEventListener("touchend", end);
    node.addEventListener("touchcancel", cancel);
    return () => {
      cancel();
      node.removeEventListener("touchstart", start);
      node.removeEventListener("touchmove", move);
      node.removeEventListener("touchend", end);
      node.removeEventListener("touchcancel", cancel);
    };
  }, []);
  return {
    ref: panel,
    onPointerDown(event: PointerEvent<HTMLElement>) {
      pen.current = null;
      if (
        options.disabled ||
        !event.isPrimary ||
        event.pointerType !== "pen" ||
        !canStart(event.target, event.currentTarget)
      )
        return;
      pen.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const start = pen.current;
      if (!start || start.id !== event.pointerId) return;
      const dx = Math.abs(event.clientX - start.x),
        dy = Math.abs(event.clientY - start.y);
      if (dy > 10 && dy > dx) pen.current = null;
    },
    onPointerUp(event: PointerEvent<HTMLElement>) {
      const start = pen.current;
      pen.current = null;
      if (start && start.id === event.pointerId)
        finish(start, event.clientX, event.clientY);
    },
    onPointerCancel() {
      pen.current = null;
    },
  };
}
