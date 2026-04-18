import { Bot as BotIcon } from 'lucide-react';
import { BotConnectionBadge } from './BotConnectionBadge';
import type { Bot } from '../../stores/bots';

interface Props {
  bot: Bot;
  selected: boolean;
  onSelect: (id: string) => void;
}

export function BotListItem({ bot, selected, onSelect }: Props) {
  return (
    <button
      type="button"
      aria-selected={selected}
      onClick={() => onSelect(bot.id)}
      className={[
        'w-full flex items-center gap-3 p-3 rounded-lg border text-left',
        'transition-colors',
        selected
          ? 'bg-accent/30 border-accent'
          : 'bg-card hover:bg-muted/40 border-border',
      ].join(' ')}
    >
      <div className="flex-shrink-0 size-10 rounded-md bg-muted flex items-center justify-center">
        <BotIcon size={20} className="text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium truncate">{bot.name}</span>
          <span className="text-xs px-1.5 py-0.5 rounded bg-muted uppercase">
            {bot.concurrency_mode}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
          <span>{bot.channel}</span>
          <BotConnectionBadge bot={bot} />
        </div>
      </div>
    </button>
  );
}
