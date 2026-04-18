import { Circle, Loader2, AlertTriangle, PowerOff } from 'lucide-react';
import type { Bot, BotConnectionState } from '../../stores/bots';

interface StateMeta {
  label: string;
  cls: string;
  Icon: React.ComponentType<{ size?: number; className?: string }>;
  animated: boolean;
}

const STATE_META: Record<BotConnectionState, StateMeta> = {
  connected:    { label: '已连接',   cls: 'text-emerald-500',       Icon: Circle,         animated: false },
  connecting:   { label: '连接中',   cls: 'text-blue-500',          Icon: Loader2,        animated: true  },
  reconnecting: { label: '重连中',   cls: 'text-blue-500',          Icon: Loader2,        animated: true  },
  error:        { label: '连接失败', cls: 'text-red-500',           Icon: AlertTriangle,  animated: false },
  disconnected: { label: '未连接',   cls: 'text-muted-foreground',  Icon: Circle,         animated: false },
  disabled:     { label: '已停用',   cls: 'text-muted-foreground',  Icon: PowerOff,       animated: false },
};

interface BotConnectionBadgeProps {
  bot: Bot;
}

export function BotConnectionBadge({ bot }: BotConnectionBadgeProps) {
  const meta = STATE_META[bot.connection_state] ?? STATE_META.disconnected;

  const displayText =
    bot.connection_state === 'error' && bot.last_error_code
      ? `${meta.label}（${bot.last_error_code}）`
      : meta.label;

  const tooltipParts: string[] = [];
  if (bot.last_connected_at) {
    tooltipParts.push(`最近连接：${bot.last_connected_at.slice(0, 10)}`);
  }
  if (bot.connection_state === 'error' && bot.consecutive_failures > 0) {
    tooltipParts.push(`连续失败：${bot.consecutive_failures} 次`);
  }
  const title = tooltipParts.length > 0 ? tooltipParts.join(' | ') : undefined;

  return (
    <span
      aria-label={meta.label}
      title={title}
      className={`inline-flex items-center gap-1 transition-colors duration-300 ${meta.cls}`}
    >
      <meta.Icon
        size={10}
        className={meta.animated ? 'animate-spin' : 'fill-current'}
      />
      <span className="text-xs">{displayText}</span>
    </span>
  );
}
