import clsx from 'clsx';

interface Props { label: string; variant?: 'critical' | 'warning' | 'success' | 'info' | 'muted' | 'purple'; size?: 'sm' | 'xs'; }

const VARIANTS = {
  critical: 'bg-[#f85149]/15 text-[#f85149] border border-[#f85149]/30',
  warning:  'bg-[#d29922]/15 text-[#d29922] border border-[#d29922]/30',
  success:  'bg-[#3fb950]/15 text-[#3fb950] border border-[#3fb950]/30',
  info:     'bg-[#58a6ff]/15 text-[#58a6ff] border border-[#58a6ff]/30',
  muted:    'bg-[#21262d] text-[#8b949e] border border-[#30363d]',
  purple:   'bg-[#bc8cff]/15 text-[#bc8cff] border border-[#bc8cff]/30',
};

export default function Badge({ label, variant = 'muted', size = 'sm' }: Props) {
  return (
    <span className={clsx(
      'inline-flex items-center rounded-full font-medium',
      size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-1.5 py-px text-[10px]',
      VARIANTS[variant],
    )}>
      {label}
    </span>
  );
}
