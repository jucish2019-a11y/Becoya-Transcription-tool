import { useCallback, useRef, useState } from 'react';

/** Microphone recording. Calls `onComplete` with the finished audio when stopped. */
export function useRecorder(onComplete: (blob: Blob, mimeType: string, name: string) => void) {
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState('');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const partsRef = useRef<Blob[]>([]);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const start = useCallback(async () => {
    try {
      setError('');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      partsRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) partsRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(partsRef.current, { type: recorder.mimeType });
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        onCompleteRef.current(blob, recorder.mimeType, `Recording at ${time}`);
      };

      recorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error('Error accessing microphone:', err);
      setError('Could not access microphone. Please ensure permissions are granted.');
    }
  }, []);

  const stop = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
      setIsRecording(false);
    }
  }, []);

  return { isRecording, error, start, stop };
}
