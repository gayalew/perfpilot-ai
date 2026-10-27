import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

const ToastContext = createContext<(text: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Array<{ id: number; text: string }>>([]);
  const push = useCallback((text: string) => {
    const id = Date.now() + Math.random();
    setItems((list) => [...list, { id, text }]);
    window.setTimeout(() => setItems((list) => list.filter((item) => item.id !== id)), 4000);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(20rem,calc(100%-2rem))] flex-col gap-2">
        {items.map((item) => (
          <div key={item.id} role="status" className="rounded-md bg-zinc-900 px-3 py-2 text-sm text-white shadow-lg dark:bg-zinc-100 dark:text-zinc-900">
            {item.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (text: string) => void {
  return useContext(ToastContext);
}
