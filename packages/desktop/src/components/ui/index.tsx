/**
 * PearTube UI Components
 * Consistent, cross-platform UI primitives
 */

import React from 'react';
import { colors, spacing, radius, fontSize, fontWeight, transitions } from '../../lib/theme';

// ============================================================================
// CSS-in-JS Helper
// ============================================================================

type CSSProperties = React.CSSProperties;

// Helper function kept for potential future use
// const css = (styles: CSSProperties): CSSProperties => styles;

// ============================================================================
// Layout Components
// ============================================================================

interface BoxProps extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
  style?: CSSProperties;
}

export const Box: React.FC<BoxProps> = ({ children, style, ...props }) => (
  <div style={{ display: 'flex', flexDirection: 'column', ...style }} {...props}>
    {children}
  </div>
);

export const Row: React.FC<BoxProps & { gap?: number; align?: string; justify?: string }> = ({
  children, style, gap = 0, align, justify, ...props
}) => (
  <div style={{
    display: 'flex',
    flexDirection: 'row',
    gap,
    alignItems: align,
    justifyContent: justify,
    ...style
  }} {...props}>
    {children}
  </div>
);

export const Column: React.FC<BoxProps & { gap?: number; align?: string; justify?: string }> = ({
  children, style, gap = 0, align, justify, ...props
}) => (
  <div style={{
    display: 'flex',
    flexDirection: 'column',
    gap,
    alignItems: align,
    justifyContent: justify,
    ...style
  }} {...props}>
    {children}
  </div>
);

export const Center: React.FC<BoxProps> = ({ children, style, ...props }) => (
  <div style={{
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    ...style
  }} {...props}>
    {children}
  </div>
);

// ============================================================================
// Typography
// ============================================================================

interface TextProps extends React.HTMLAttributes<HTMLSpanElement> {
  children?: React.ReactNode;
  style?: CSSProperties;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl' | 'xxxl';
  weight?: 'normal' | 'medium' | 'semibold' | 'bold';
  color?: 'primary' | 'secondary' | 'muted' | 'disabled' | 'accent' | 'error' | 'success';
  truncate?: boolean;
}

export const Text: React.FC<TextProps> = ({
  children, style, size = 'md', weight = 'normal', color = 'primary', truncate, ...props
}) => {
  const colorMap = {
    primary: colors.textPrimary,
    secondary: colors.textSecondary,
    muted: colors.textMuted,
    disabled: colors.textDisabled,
    accent: colors.accent,
    error: colors.error,
    success: colors.success,
  };

  return (
    <span style={{
      fontSize: fontSize[size],
      fontWeight: fontWeight[weight],
      color: colorMap[color],
      ...(truncate ? {
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      } : {}),
      ...style
    }} {...props}>
      {children}
    </span>
  );
};

export const Heading: React.FC<TextProps & { level?: 1 | 2 | 3 | 4 }> = ({
  children, style, level = 1, ...props
}) => {
  const sizes: Record<number, 'xxxl' | 'xxl' | 'xl' | 'lg'> = { 1: 'xxxl', 2: 'xxl', 3: 'xl', 4: 'lg' };
  return (
    <Text size={sizes[level]} weight="bold" style={{ display: 'block', margin: 0, ...style }} {...props}>
      {children}
    </Text>
  );
};

// ============================================================================
// Button
// ============================================================================

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
  icon?: React.ReactNode;
  loading?: boolean;
}

export const Button: React.FC<ButtonProps> = ({
  children, variant = 'secondary', size = 'md', fullWidth, icon, loading, disabled, style, ...props
}) => {
  const [hovered, setHovered] = React.useState(false);

  const baseStyles: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    border: 'none',
    borderRadius: radius.md,
    cursor: disabled || loading ? 'not-allowed' : 'pointer',
    fontWeight: fontWeight.semibold,
    transition: transitions.fast,
    opacity: disabled ? 0.5 : 1,
    width: fullWidth ? '100%' : undefined,
  };

  const sizeStyles: Record<string, CSSProperties> = {
    sm: { padding: `${spacing.xs}px ${spacing.md}px`, fontSize: fontSize.sm },
    md: { padding: `${spacing.sm}px ${spacing.lg}px`, fontSize: fontSize.md },
    lg: { padding: `${spacing.md}px ${spacing.xl}px`, fontSize: fontSize.lg },
  };

  const variantStyles: Record<string, CSSProperties> = {
    primary: {
      backgroundColor: hovered ? colors.primaryHover : colors.primary,
      color: colors.textPrimary,
    },
    secondary: {
      backgroundColor: hovered ? colors.surfaceHover : colors.surface,
      color: colors.textPrimary,
    },
    ghost: {
      backgroundColor: hovered ? colors.bgHover : 'transparent',
      color: colors.textPrimary,
    },
    danger: {
      backgroundColor: hovered ? colors.error : colors.errorLight,
      color: hovered ? colors.textPrimary : colors.error,
    },
  };

  return (
    <button
      style={{ ...baseStyles, ...sizeStyles[size], ...variantStyles[variant], ...style }}
      disabled={disabled || loading}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      {...props}
    >
      {loading ? <Spinner size="sm" /> : icon}
      {children}
    </button>
  );
};

// ============================================================================
// IconButton
// ============================================================================

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'ghost' | 'filled';
  active?: boolean;
}

export const IconButton: React.FC<IconButtonProps> = ({
  icon, size = 'md', variant = 'ghost', active, disabled, style, ...props
}) => {
  const [hovered, setHovered] = React.useState(false);

  const sizes = { sm: 28, md: 36, lg: 44 };
  const iconSizes = { sm: 16, md: 20, lg: 24 };

  return (
    <button
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: sizes[size],
        height: sizes[size],
        border: 'none',
        borderRadius: radius.md,
        cursor: disabled ? 'not-allowed' : 'pointer',
        backgroundColor: active || hovered
          ? (variant === 'filled' ? colors.surfaceHover : colors.bgHover)
          : (variant === 'filled' ? colors.surface : 'transparent'),
        color: active ? colors.primary : colors.textSecondary,
        opacity: disabled ? 0.5 : 1,
        transition: transitions.fast,
        fontSize: iconSizes[size],
        ...style
      }}
      disabled={disabled}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      {...props}
    >
      {icon}
    </button>
  );
};

// ============================================================================
// Input
// ============================================================================

interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: 'sm' | 'md' | 'lg';
  icon?: React.ReactNode;
  error?: boolean;
}

export const Input: React.FC<InputProps> = ({
  size = 'md', icon, error, style, ...props
}) => {
  const [focused, setFocused] = React.useState(false);

  const heights = { sm: 32, md: 40, lg: 48 };

  return (
    <div style={{
      position: 'relative',
      display: 'flex',
      alignItems: 'center',
    }}>
      {icon && (
        <span style={{
          position: 'absolute',
          left: spacing.md,
          color: colors.textMuted,
          fontSize: fontSize.lg,
          pointerEvents: 'none',
        }}>
          {icon}
        </span>
      )}
      <input
        style={{
          width: '100%',
          height: heights[size],
          padding: `0 ${spacing.md}px`,
          paddingLeft: icon ? spacing.xxxl : spacing.md,
          backgroundColor: colors.bgElevated,
          border: `1px solid ${error ? colors.error : focused ? colors.borderFocus : colors.border}`,
          borderRadius: radius.md,
          color: colors.textPrimary,
          fontSize: fontSize.md,
          outline: 'none',
          transition: transitions.fast,
          ...style
        }}
        onFocus={(e) => { setFocused(true); props.onFocus?.(e); }}
        onBlur={(e) => { setFocused(false); props.onBlur?.(e); }}
        {...props}
      />
    </div>
  );
};

// ============================================================================
// TextArea
// ============================================================================

interface TextAreaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean;
}

export const TextArea: React.FC<TextAreaProps> = ({ error, style, ...props }) => {
  const [focused, setFocused] = React.useState(false);

  return (
    <textarea
      style={{
        width: '100%',
        minHeight: 100,
        padding: spacing.md,
        backgroundColor: colors.bgElevated,
        border: `1px solid ${error ? colors.error : focused ? colors.borderFocus : colors.border}`,
        borderRadius: radius.md,
        color: colors.textPrimary,
        fontSize: fontSize.md,
        fontFamily: 'inherit',
        resize: 'vertical',
        outline: 'none',
        transition: transitions.fast,
        ...style
      }}
      onFocus={(e) => { setFocused(true); props.onFocus?.(e); }}
      onBlur={(e) => { setFocused(false); props.onBlur?.(e); }}
      {...props}
    />
  );
};

// ============================================================================
// Card
// ============================================================================

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
  interactive?: boolean;
  padding?: 'none' | 'sm' | 'md' | 'lg';
}

export const Card: React.FC<CardProps> = ({
  children, interactive, padding = 'md', style, ...props
}) => {
  const [hovered, setHovered] = React.useState(false);

  const paddingMap = { none: 0, sm: spacing.sm, md: spacing.lg, lg: spacing.xl };

  return (
    <div
      style={{
        backgroundColor: hovered && interactive ? colors.surfaceHover : colors.surface,
        borderRadius: radius.lg,
        padding: paddingMap[padding],
        cursor: interactive ? 'pointer' : undefined,
        transition: transitions.fast,
        ...style
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      {...props}
    >
      {children}
    </div>
  );
};

// ============================================================================
// Avatar
// ============================================================================

interface AvatarProps {
  src?: string;
  name?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  style?: CSSProperties;
}

export const Avatar: React.FC<AvatarProps> = ({ src, name, size = 'md', style }) => {
  const sizes = { xs: 24, sm: 32, md: 40, lg: 56, xl: 80 };
  const fontSizes = { xs: 10, sm: 12, md: 14, lg: 20, xl: 28 };
  const s = sizes[size];

  const initial = name ? name[0].toUpperCase() : '?';

  return (
    <div style={{
      width: s,
      height: s,
      borderRadius: radius.full,
      backgroundColor: colors.primary,
      backgroundImage: src ? `url(${src})` : undefined,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
      ...style
    }}>
      {!src && (
        <Text style={{ fontSize: fontSizes[size], fontWeight: fontWeight.bold }}>
          {initial}
        </Text>
      )}
    </div>
  );
};

// ============================================================================
// Badge
// ============================================================================

interface BadgeProps {
  children: React.ReactNode;
  variant?: 'default' | 'primary' | 'success' | 'warning' | 'error';
  style?: CSSProperties;
}

export const Badge: React.FC<BadgeProps> = ({ children, variant = 'default', style }) => {
  const variantStyles: Record<string, CSSProperties> = {
    default: { backgroundColor: colors.surface, color: colors.textSecondary },
    primary: { backgroundColor: colors.primaryLight, color: colors.primary },
    success: { backgroundColor: colors.successLight, color: colors.success },
    warning: { backgroundColor: colors.warningLight, color: colors.warning },
    error: { backgroundColor: colors.errorLight, color: colors.error },
  };

  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      padding: `${spacing.xs}px ${spacing.sm}px`,
      borderRadius: radius.sm,
      fontSize: fontSize.xs,
      fontWeight: fontWeight.semibold,
      ...variantStyles[variant],
      ...style
    }}>
      {children}
    </span>
  );
};

// ============================================================================
// Spinner
// ============================================================================

interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  color?: string;
}

export const Spinner: React.FC<SpinnerProps> = ({ size = 'md', color = colors.primary }) => {
  const sizes = { sm: 16, md: 24, lg: 32 };

  return (
    <div style={{
      width: sizes[size],
      height: sizes[size],
      border: `2px solid ${colors.border}`,
      borderTopColor: color,
      borderRadius: '50%',
      animation: 'spin 0.8s linear infinite',
    }} />
  );
};

// ============================================================================
// Divider
// ============================================================================

interface DividerProps {
  vertical?: boolean;
  style?: CSSProperties;
}

export const Divider: React.FC<DividerProps> = ({ vertical, style }) => (
  <div style={{
    backgroundColor: colors.border,
    ...(vertical ? { width: 1, height: '100%' } : { height: 1, width: '100%' }),
    ...style
  }} />
);

// ============================================================================
// Alert
// ============================================================================

interface AlertProps {
  children: React.ReactNode;
  variant?: 'info' | 'success' | 'warning' | 'error';
  onClose?: () => void;
  style?: CSSProperties;
}

export const Alert: React.FC<AlertProps> = ({ children, variant = 'info', onClose, style }) => {
  const variantStyles: Record<string, CSSProperties> = {
    info: { backgroundColor: colors.primaryLight, borderColor: colors.primary },
    success: { backgroundColor: colors.successLight, borderColor: colors.success },
    warning: { backgroundColor: colors.warningLight, borderColor: colors.warning },
    error: { backgroundColor: colors.errorLight, borderColor: colors.error },
  };

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: spacing.md,
      borderRadius: radius.md,
      borderLeft: '4px solid',
      ...variantStyles[variant],
      ...style
    }}>
      <Text size="sm">{children}</Text>
      {onClose && (
        <IconButton icon="x" size="sm" onClick={onClose} />
      )}
    </div>
  );
};

// ============================================================================
// Tabs
// ============================================================================

interface TabsProps {
  tabs: { id: string; label: string; icon?: React.ReactNode }[];
  activeTab: string;
  onChange: (id: string) => void;
  style?: CSSProperties;
}

export const Tabs: React.FC<TabsProps> = ({ tabs, activeTab, onChange, style }) => (
  <Row gap={spacing.xs} style={{ borderBottom: `1px solid ${colors.border}`, ...style }}>
    {tabs.map((tab) => (
      <button
        key={tab.id}
        onClick={() => onChange(tab.id)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: spacing.sm,
          padding: `${spacing.md}px ${spacing.lg}px`,
          backgroundColor: 'transparent',
          border: 'none',
          borderBottom: `2px solid ${activeTab === tab.id ? colors.primary : 'transparent'}`,
          color: activeTab === tab.id ? colors.textPrimary : colors.textSecondary,
          fontSize: fontSize.md,
          fontWeight: fontWeight.medium,
          cursor: 'pointer',
          transition: transitions.fast,
          marginBottom: -1,
        }}
      >
        {tab.icon}
        {tab.label}
      </button>
    ))}
  </Row>
);

// ============================================================================
// Empty State
// ============================================================================

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}

export const EmptyState: React.FC<EmptyStateProps> = ({ icon, title, description, action }) => (
  <Center style={{ flexDirection: 'column', padding: spacing.xxxl, gap: spacing.lg }}>
    {icon && <div style={{ fontSize: 48, color: colors.textMuted }}>{icon}</div>}
    <Column gap={spacing.sm} align="center">
      <Text size="lg" weight="semibold">{title}</Text>
      {description && <Text color="secondary">{description}</Text>}
    </Column>
    {action}
  </Center>
);

// ============================================================================
// Global Styles (inject once)
// ============================================================================

if (typeof document !== 'undefined') {
  const styleId = 'peartube-global-styles';
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }

      * {
        box-sizing: border-box;
      }

      input::placeholder,
      textarea::placeholder {
        color: ${colors.textMuted};
      }

      ::-webkit-scrollbar {
        width: 8px;
        height: 8px;
      }

      ::-webkit-scrollbar-track {
        background: transparent;
      }

      ::-webkit-scrollbar-thumb {
        background: ${colors.border};
        border-radius: 4px;
      }

      ::-webkit-scrollbar-thumb:hover {
        background: ${colors.borderLight};
      }
    `;
    document.head.appendChild(style);
  }
}

// Re-exports for backwards compatibility
export { colors, spacing, radius, fontSize, fontWeight } from '../../lib/theme';
