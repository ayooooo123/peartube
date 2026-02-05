import { StatusBar } from 'expo-status-bar'
import { useState, useRef } from 'react'
import { StyleSheet, View, Text, TouchableOpacity, SafeAreaView } from 'react-native'
import { NitroVLCView, callback } from 'react-native-nitro-vlc'
import type { NitroVLCViewSpec, OnProgressEventProps, VideoInfo } from 'react-native-nitro-vlc'

const TEST_VIDEO_URL = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4'

export default function App() {
  const [paused, setPaused] = useState(false)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(0)
  const viewRef = useRef<NitroVLCViewSpec>(null)

  const handleProgress = (event: OnProgressEventProps) => {
    setProgress(event.currentTime)
    setDuration(event.duration)
  }

  const handleLoad = (info: VideoInfo) => {
    setDuration(info.duration)
    console.log('Video loaded:', info)
  }

  const formatTime = (ms: number) => {
    const totalSeconds = Math.floor(ms / 1000)
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${minutes}:${seconds.toString().padStart(2, '0')}`
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />
      <Text style={styles.title}>NitroVLC Example</Text>
      
      <View style={styles.playerContainer}>
        <NitroVLCView
          style={styles.player}
          hybridRef={callback((ref) => {
            viewRef.current = ref
          })}
          source={{ uri: TEST_VIDEO_URL }}
          paused={paused}
          autoplay={true}
          resizeMode="contain"
          onProgress={callback(handleProgress)}
          onLoad={callback(handleLoad)}
          onError={callback(() => console.error('Playback error'))}
        />
      </View>

      <View style={styles.controls}>
        <Text style={styles.time}>
          {formatTime(progress)} / {formatTime(duration)}
        </Text>
        
        <View style={styles.buttons}>
          <TouchableOpacity
            style={styles.button}
            onPress={() => setPaused(!paused)}
          >
            <Text style={styles.buttonText}>{paused ? 'Play' : 'Pause'}</Text>
          </TouchableOpacity>
          
          <TouchableOpacity
            style={styles.button}
            onPress={() => viewRef.current?.seek(0)}
          >
            <Text style={styles.buttonText}>Restart</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0e0e10',
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#efeff1',
    textAlign: 'center',
    marginVertical: 16,
  },
  playerContainer: {
    flex: 1,
    backgroundColor: '#000',
    marginHorizontal: 16,
    borderRadius: 8,
    overflow: 'hidden',
  },
  player: {
    flex: 1,
  },
  controls: {
    padding: 16,
  },
  time: {
    color: '#efeff1',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 12,
  },
  buttons: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 16,
  },
  button: {
    backgroundColor: '#9147ff',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  buttonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 16,
  },
})
