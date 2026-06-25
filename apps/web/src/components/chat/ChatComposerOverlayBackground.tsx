export function ChatComposerOverlayBackground() {
  return (
    <div
      aria-hidden="true"
      className="chat-composer-horizontal-inset pointer-events-none absolute inset-x-0 top-1.5 bottom-0 z-0 sm:top-2"
    >
      <div className="relative h-full w-full overflow-clip rounded-t-[20px]">
        <div className="chat-composer-shared-blur absolute -inset-8" />
      </div>
    </div>
  );
}
