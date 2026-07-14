'use client';

import { useEffect, useState } from 'react';
import {
  IS_INTEGRATED,
  notifyIntegrationReady,
  setupHostThemeListener,
} from '@/lib/integration';
import {
  runIntegrationBootstrap,
  type IntegrationBootstrapResult,
} from '@/lib/integration-bootstrap';

function dismissBootLoader(): void {
  const el = document.getElementById('app-boot-loader');
  if (el) el.remove();
}

/**
 * 集成模式启动闸门：在平台会话/模型播种完成前不渲染工作台
 * （模型注册表在 localStorage，必须先播种再让组件读取）。
 * 独立部署（IS_INTEGRATED=false）直接透传 children，零开销。
 */
export function IntegrationGate({ children }: { children: React.ReactNode }) {
  const [result, setResult] = useState<IntegrationBootstrapResult | null>(null);

  useEffect(() => {
    if (!IS_INTEGRATED) return;
    const teardownTheme = setupHostThemeListener();
    let active = true;
    runIntegrationBootstrap().then((outcome) => {
      if (!active) return;
      setResult(outcome);
      if (outcome.status === 'ready') {
        notifyIntegrationReady();
      } else {
        // 工作台不会挂载，boot loader 需要在这里移除以显示错误信息
        dismissBootLoader();
      }
    });
    return () => {
      active = false;
      teardownTheme();
    };
  }, []);

  if (!IS_INTEGRATED) {
    return <>{children}</>;
  }

  if (!result) {
    // 引导期间由 layout 的 #app-boot-loader 全屏遮罩覆盖
    return null;
  }

  if (result.status !== 'ready') {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-3 bg-background px-6 text-center">
        <div className="text-base font-medium text-foreground">
          {result.message || '初始化失败'}
        </div>
        <button
          type="button"
          className="rounded-md border border-border px-4 py-2 text-sm text-foreground hover:bg-accent"
          onClick={() => window.location.reload()}
        >
          重新加载
        </button>
      </div>
    );
  }

  return <>{children}</>;
}
