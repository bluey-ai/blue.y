import clsx from 'clsx';

interface Props {
  children: React.ReactNode;
  className?: string;
  glow?: 'blue' | 'red' | 'green' | 'none';
  padding?: boolean;
}

export default function Card({ children, className, glow = 'none', padding = true }: Props) {
  return (
    <div className={clsx(
      'rounded-xl border border-[#30363d] bg-[#161b22]',
      glow === 'blue' && 'glow-blue',
      glow === 'red'  && 'glow-red',
      glow === 'green'&& 'glow-green',
      padding && 'p-4',
      className,
    )}>
      {children}
    </div>
  );
}
