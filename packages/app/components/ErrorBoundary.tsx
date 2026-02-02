/**
 * ErrorBoundary - Catch and display React rendering errors gracefully
 *
 * Wraps the app to prevent crashes from propagating to the user.
 * Shows a fallback UI with retry option instead of a blank screen.
 */
import React, { Component, ReactNode } from 'react'
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native'
import { colors } from '@/lib/colors'

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
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    })
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
          <View style={styles.content}>
            <Text style={styles.title}>Something went wrong</Text>
            <Text style={styles.subtitle}>
              The app encountered an unexpected error.
            </Text>

            {__DEV__ && this.state.error && (
              <View style={styles.errorBox}>
                <Text style={styles.errorTitle}>Error Details (dev only):</Text>
                <Text style={styles.errorMessage} numberOfLines={5}>
                  {this.state.error.message}
                </Text>
              </View>
            )}

            <Pressable style={styles.retryButton} onPress={this.handleRetry}>
              <Text style={styles.retryButtonText}>Try Again</Text>
            </Pressable>

            <Text style={styles.hint}>
              If this keeps happening, try restarting the app.
            </Text>
          </View>
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
    padding: 24,
  },
  content: {
    maxWidth: 400,
    alignItems: 'center',
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 12,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 16,
    color: colors.textMuted,
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 24,
  },
  errorBox: {
    backgroundColor: colors.bgElevated,
    borderRadius: 8,
    padding: 16,
    marginBottom: 24,
    width: '100%',
  },
  errorTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textMuted,
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  errorMessage: {
    fontSize: 13,
    color: colors.red,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  retryButton: {
    backgroundColor: colors.accent,
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 8,
    marginBottom: 24,
  },
  retryButtonText: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
  },
  hint: {
    fontSize: 13,
    color: colors.textMuted,
    textAlign: 'center',
  },
})

export default ErrorBoundary
