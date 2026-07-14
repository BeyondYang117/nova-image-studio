'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/workspace/dialogs/ConfirmDialog';
import { apiPath } from '@/lib/integration';

export interface QuickPromptItem {
  title: string;
  content: string;
  type: 1 | 2; // 1=文生图, 2=图生图
}

interface QuickPromptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentMode: 'text-to-image' | 'image-to-image';
  currentPrompt: string;
  onSelect: (content: string) => void;
}

async function fetchPrompts(): Promise<QuickPromptItem[]> {
  try {
    const res = await fetch(apiPath('/api/nova/prompts'));
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

export function QuickPromptDialog({
  open,
  onOpenChange,
  currentMode,
  currentPrompt,
  onSelect,
}: QuickPromptDialogProps) {
  const [prompts, setPrompts] = useState<QuickPromptItem[]>([]);
  const [activeMode, setActiveMode] = useState(currentMode);
  const [overwriteTarget, setOverwriteTarget] = useState<QuickPromptItem | null>(null);
  const prevOpenRef = useRef(false);

  useEffect(() => {
    if (!open) {
      prevOpenRef.current = false;
      return;
    }
    if (!prevOpenRef.current) {
      prevOpenRef.current = true;
      setActiveMode(currentMode);
      setOverwriteTarget(null);
    }
    void fetchPrompts().then(setPrompts);
  }, [currentMode, open]);

  const handleClose = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const handleClick = useCallback((item: QuickPromptItem) => {
    if (currentPrompt.trim().length > 0) {
      setOverwriteTarget(item);
    } else {
      onSelect(item.content);
      onOpenChange(false);
    }
  }, [currentPrompt, onSelect, onOpenChange]);

  const handleConfirmOverwrite = useCallback(() => {
    if (overwriteTarget) {
      onSelect(overwriteTarget.content);
      setOverwriteTarget(null);
      onOpenChange(false);
    }
  }, [overwriteTarget, onSelect, onOpenChange]);

  const handleCancelOverwrite = useCallback(() => {
    setOverwriteTarget(null);
  }, []);

  const filteredPrompts = prompts.filter(p => {
    if (activeMode === 'text-to-image') return p.type === 1;
    return p.type === 2;
  });

  if (!open) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-stretch justify-center overflow-y-auto bg-black/50 sm:items-center sm:p-4"
        style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, width: '100vw', height: '100vh' }}
        onClick={handleClose}
        onWheel={e => e.stopPropagation()}
        onTouchMove={e => e.stopPropagation()}
      >
        <div
          className="flex min-h-[100dvh] w-full flex-col overflow-y-auto rounded-none border border-border bg-card p-6 pt-12 shadow-lg sm:min-h-0 sm:max-w-lg sm:rounded-xl sm:pt-6"
          onClick={e => e.stopPropagation()}
        >
          <div className="mb-4 flex items-center gap-2">
            <Zap className="w-5 h-5 text-primary" />
            <h3 className="text-lg font-semibold">快速提示词</h3>
          </div>

          <div className="mb-4 flex w-fit rounded-lg border border-border bg-background p-0.5">
            <button
              type="button"
              onClick={() => setActiveMode('text-to-image')}
              className={`h-7 rounded-md px-3 text-sm transition-colors ${activeMode === 'text-to-image'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
            >
              文生图
            </button>
            <button
              type="button"
              onClick={() => setActiveMode('image-to-image')}
              className={`h-7 rounded-md px-3 text-sm transition-colors ${activeMode === 'image-to-image'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
            >
              图生图
            </button>
          </div>

          {filteredPrompts.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无可用模板</p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {filteredPrompts.map((item, index) => (
                <button
                  key={`${item.title}-${index}`}
                  onClick={() => handleClick(item)}
                  className="rounded-lg border border-border bg-muted/40 p-3 text-center transition-colors hover:bg-muted hover:text-foreground"
                >
                  <span className="text-sm font-medium leading-snug">{item.title}</span>
                </button>
              ))}
            </div>
          )}

          <div className="mt-4 flex justify-end">
            <Button variant="outline" size="sm" onClick={handleClose}>
              关闭
            </Button>
          </div>
        </div>
      </div>

      {overwriteTarget && (
        <ConfirmDialog
          title="覆盖提示词"
          message={
            <p>当前输入框已有内容，是否要用「{overwriteTarget.title}」模板覆盖？</p>
          }
          confirmText="覆盖"
          cancelText="取消"
          variant="default"
          onConfirm={handleConfirmOverwrite}
          onCancel={handleCancelOverwrite}
        />
      )}
    </>
  );
}
