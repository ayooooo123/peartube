import React from 'react'
import {
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  type PressableProps,
  type StyleProp,
  type SwitchProps,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native'
import { colors, radius, spacing, borderWidth } from '@/lib/colors'
import { fonts } from '@/lib/typography'

// Plain React Native replacements for the former @expo/ui pilot widgets.
// @expo/ui pulled the whole Jetpack Compose runtime (~MBs of dex) into the
// Android APK for three trivial controls, so the pilot was rolled back.

export type NativeButtonProps = Omit<PressableProps, 'style'> & {
  label: string
  variant?: 'filled' | 'outlined'
  style?: StyleProp<ViewStyle>
  className?: string
}

export function NativeButton({ label, variant = 'filled', style, disabled, className: _className, ...props }: NativeButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      {...props}
      style={({ pressed }) => [
        styles.button,
        variant === 'filled' ? styles.buttonFilled : styles.buttonOutlined,
        disabled && styles.buttonDisabled,
        pressed && styles.buttonPressed,
        style,
      ]}
    >
      <Text style={[styles.buttonLabel, variant === 'filled' ? styles.buttonLabelFilled : styles.buttonLabelOutlined]}>
        {label}
      </Text>
    </Pressable>
  )
}

export type NativeSwitchProps = SwitchProps & {
  className?: string
}

export function NativeSwitch({ className: _className, trackColor, thumbColor, ...props }: NativeSwitchProps) {
  return (
    <Switch
      trackColor={trackColor ?? { true: colors.primary, false: colors.bgActive }}
      thumbColor={thumbColor ?? colors.text}
      {...props}
    />
  )
}

export type NativeTextInputProps = TextInputProps & {
  className?: string
  textStyle?: StyleProp<TextStyle>
}

export function NativeTextInput({ style, textStyle, className, ...props }: NativeTextInputProps) {
  // Call sites style via nativewind `className`; only apply the fallback
  // styles when no className is provided.
  return (
    <TextInput
      className={className}
      placeholderTextColor={props.placeholderTextColor ?? colors.textMuted}
      {...props}
      style={[!className && styles.input, styles.text, style, textStyle]}
    />
  )
}

const styles = StyleSheet.create({
  button: {
    alignSelf: 'stretch',
    minHeight: 44,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonFilled: {
    backgroundColor: colors.primary,
    borderWidth: borderWidth.rule,
    borderColor: colors.primary,
  },
  buttonOutlined: {
    borderWidth: borderWidth.rule,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonPressed: {
    opacity: 0.8,
  },
  buttonLabel: {
    ...fonts.label.md,
  },
  buttonLabelFilled: {
    color: colors.onPrimary,
  },
  buttonLabelOutlined: {
    color: colors.text,
  },
  input: {
    minHeight: 48,
    marginBottom: spacing.md,
    backgroundColor: colors.surfaceHover,
    borderColor: colors.border,
    borderWidth: borderWidth.rule,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  text: {
    color: colors.text,
    ...fonts.body.md,
  },
})
