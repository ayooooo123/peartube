/**
 * ErrorBoundary - Catch and display React rendering errors gracefully
 *
 * Wraps the app to prevent crashes from propagating to the user.
 * Shows a fallback UI with retry option instead of a blank screen.
 */
import React, { Component, ReactNode } from 'react'
import { View, Text, StyleSheet, Platform } from 'react-native'
import { colors, radius, spacing, borderWidth } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import { Panel, Button, Eyebrow, Body } from '@/components/primitives'

interface ErrorBoundaryProps {
  children: ReactNode
  /** Called when user taps retry */
  onRetry?: () => void
  /** Custom fallback component */
  fallback?: ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
  errorInfo: React.ErrorInfo | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    }
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // Log error locally (no external crash reporting for privacy)
    console.error('[ErrorBoundary] Caught error:', error.message)
    console.error('[ErrorBoundary] Component stack:', errorInfo.componentStack)

    this.setState({ errorInfo })

    // Store error in local logs for debugging
    this.logErrorLocally(error, errorInfo)
  }

  /**
   * Store error in local logs (device-only, no network)
   */
  private logErrorLocally(error: Error, errorInfo: React.ErrorInfo) {
    try {
      // Store in memory for potential future local log viewer
      const errorLog = {
        timestamp: new Date().toISOString(),
        message: error.message,
        stack: error.stack,
        componentStack: errorInfo.componentStack,
        platform: Platform.OS,
      }

      // Log to console with structured format
      console.log('[ErrorBoundary] Error log:', JSON.stringify(errorLog, null, 2))

      // Future: Could write to AsyncStorage or file system for local log viewer
    } catch {
      // Ignore logging errors
    }
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null, errorInfo: null })
    this.props.onRetry?.()
  }

  render() {
    if (this.state.hasError) {
      // Custom fallback
      if (this.props.fallback) {
        return this.props.fallback
      }

      // Default fallback UI
      return (
        <View style={styles.container}>
          <Panel tone="danger" style={styles.panel}>
            <Eyebrow tone="danger">ERROR</Eyebrow>
            <Text style={styles.title}>Something went wrong</Text>
            <Body size="sm" tone="secondary" style={styles.subtitle}>
              The app encountered an unexpected error.
            </Body>

            {__DEV__ && this.state.error && (
              <View style={styles.errorBox}>
                <Text style={styles.errorTitle}>Error Details (dev only):</Text>
                <Text style={styles.errorMessage} numberOfLines={8}>
                  {this.state.error.message}
                  {this.state.errorInfo?.componentStack
                    ? `\n${this.state.errorInfo.componentStack}`
                    : ''}
                </Text>
              </View>
            )}

            <Button
              label="RETRY"
              variant="secondary"
              onPress={this.handleRetry}
              style={styles.retryButton}
            />

            <Text style={styles.hint}>
              If this keeps happening, try restarting the app.
            </Text>
          </Panel>
        </View>
      )
    }

    return this.props.children
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
  },
  panel: {
    width: '100%',
    maxWidth: 420,
  },
  title: {
    ...fonts.title.md,
    color: colors.text,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
  subtitle: {
    marginBottom: spacing.lg,
  },
  errorBox: {
    backgroundColor: colors.surfaceHover,
    borderWidth: borderWidth.hairline,
    borderColor: colors.border,
    borderRadius: radius.card,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    width: '100%',
  },
  errorTitle: {
    ...fonts.caption.sm,
    color: colors.textMuted,
    marginBottom: spacing.sm,
  },
  errorMessage: {
    ...fonts.meta.xs,
    color: colors.error,
  },
  retryButton: {
    alignSelf: 'flex-start',
    marginBottom: spacing.lg,
  },
  hint: {
    ...fonts.meta.sm,
    color: colors.textMuted,
  },
})

export default ErrorBoundary
