import type { ReactNode } from 'react';
import { colors, spacing, borderRadius } from '@peartube/shared';

// Button types
export interface ButtonProps {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  loading?: boolean;
  onPress?: () => void;
  children?: ReactNode;
  className?: string;
}

export function getButtonStyles(props: ButtonProps) {
  const { variant = 'secondary', size = 'md', disabled } = props;

  const baseStyles = {
    borderRadius: borderRadius.md,
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? 'not-allowed' : 'pointer',
  };

  const variantStyles = {
    primary: {
      backgroundColor: colors.primary,
      color: colors.text,
    },
    secondary: {
      backgroundColor: colors.bgElevated,
      color: colors.text,
      borderWidth: 1,
      borderColor: colors.border,
    },
    ghost: {
      backgroundColor: 'transparent',
      color: colors.text,
    },
    danger: {
      backgroundColor: colors.error,
      color: colors.text,
    },
  };

  const sizeStyles = {
    sm: {
      paddingVertical: spacing.xs,
      paddingHorizontal: spacing.sm,
      fontSize: 12,
    },
    md: {
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      fontSize: 14,
    },
    lg: {
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.lg,
      fontSize: 16,
    },
  };

  return {
    ...baseStyles,
    ...variantStyles[variant],
    ...sizeStyles[size],
  };
}

// Card types
export interface CardProps {
  children?: ReactNode;
  className?: string;
}

export function getCardStyles() {
  return {
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  };
}

// Input types
export interface InputProps {
  placeholder?: string;
  value?: string;
  onChangeText?: (text: string) => void;
  disabled?: boolean;
  className?: string;
}

export function getInputStyles(props: InputProps) {
  const { disabled } = props;
  return {
    backgroundColor: colors.bgElevated,
    color: colors.text,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    fontSize: 14,
    opacity: disabled ? 0.5 : 1,
  };
}

// Text types
export interface TextProps {
  variant?: 'body' | 'heading' | 'caption' | 'muted';
  children?: ReactNode;
  className?: string;
}

export function getTextStyles(props: TextProps) {
  const { variant = 'body' } = props;

  const variantStyles = {
    body: {
      color: colors.text,
      fontSize: 14,
    },
    heading: {
      color: colors.text,
      fontSize: 24,
      fontWeight: 'bold' as const,
    },
    caption: {
      color: colors.textSecondary,
      fontSize: 12,
    },
    muted: {
      color: colors.textMuted,
      fontSize: 14,
    },
  };

  return variantStyles[variant];
}
