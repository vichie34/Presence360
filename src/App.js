// src/components/AttendanceSystem.jsx
import React, { useState, useEffect } from 'react';
import {
  Camera, QrCode, MapPin, Users, Calendar, LogOut,
  Shield, AlertCircle, CheckCircle, XCircle, Download
} from 'lucide-react';

import { initializeApp } from 'firebase/app';
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from 'firebase/auth';
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  getDoc,
  getDocs,
  query,
  where,
  updateDoc,
  serverTimestamp,
  onSnapshot
} from 'firebase/firestore';

// Camera QR reader
import { QrReader } from 'react-qr-reader';

const firebaseConfig = {
  apiKey: process.env.REACT_APP_FIREBASE_API_KEY,
  authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID,
  storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.REACT_APP_FIREBASE_APP_ID
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const generateDeviceFingerprint = () => {
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillText('fingerprint', 2, 2);

    const fingerprint = {
      userAgent: navigator.userAgent,
      language: navigator.language,
      platform: navigator.platform,
      screenResolution: `${window.screen.width}x${window.screen.height}`,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      canvas: canvas.toDataURL(),
      timestamp: Date.now()
    };

    let fallback = localStorage.getItem('device_token');
    if (!fallback) {
      fallback = btoa(JSON.stringify(fingerprint)).slice(0, 32);
      localStorage.setItem('device_token', fallback);
    }

    return fallback;
  } catch (err) {
    let fallback = localStorage.getItem('device_token') || ('dev_' + Math.random().toString(36).substr(2, 16));
    localStorage.setItem('device_token', fallback);
    return fallback;
  }
};

const haversineDistance = (lat1, lon1, lat2, lon2) => {
  const toRad = (deg) => deg * (Math.PI / 180);
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

const AttendanceSystem = () => {
  const [view, setView] = useState('login');
  const [user, setUser] = useState(null);
  const [deviceId, setDeviceId] = useState('');
  const [events, setEvents] = useState([]);
  const [attendanceRecords, setAttendanceRecords] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState({ text: '', type: '' });
  const [location, setLocation] = useState(null);

  // Auth / form states
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('attendee');

  // Admin event creation states
  const [eventName, setEventName] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [qrData, setQrData] = useState('');
  // Attendee scan
  const [scanInput, setScanInput] = useState('');

  // Camera scanner state
  const [cameraOpen, setCameraOpen] = useState(false);

  // Subscriptions
  let eventsUnsub = null;
  let attendanceUnsub = null;

  useEffect(() => {
    const fingerprint = generateDeviceFingerprint();
    setDeviceId(fingerprint);

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setLocation({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy
          });
        },
        (err) => {
          console.warn('Location error:', err.message);
          showMessage('Location access denied. Some features may be limited.', 'warning');
        }
      );
    }

    const unsub = onAuthStateChanged(auth, async (fuser) => {
      if (fuser) {
        const userDoc = await getDoc(doc(db, 'users', fuser.uid));
        const profile = userDoc.exists() ? { uid: fuser.uid, ...userDoc.data() } : { uid: fuser.uid, email: fuser.email };
        setUser(profile);
        setView(profile.role === 'admin' ? 'admin' : 'attendee');

        if (profile.role === 'admin') {
          subscribeAdminData();
        } else {
          fetchUserAttendance(profile.uid);
        }
      } else {
        setUser(null);
        setView('login');
        setEvents([]);
        setAttendanceRecords([]);
      }
    });

    return () => {
      unsub();
      if (eventsUnsub) eventsUnsub();
      if (attendanceUnsub) attendanceUnsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showMessage = (text, type) => {
    setMessage({ text, type });
    setTimeout(() => setMessage({ text: '', type: '' }), 5000);
  };

  // ---------- Auth Methods ----------

  const handleRegister = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      const uid = cred.user.uid;

      const profile = {
        uid,
        email,
        name,
        role,
        deviceId,
        deviceVerified: true,
        createdAt: new Date().toISOString()
      };

      await setDoc(doc(db, 'users', uid), profile);

      setUser(profile);
      setView(role === 'admin' ? 'admin' : 'attendee');
      showMessage('Registration successful!', 'success');
    } catch (err) {
      console.error('Register error:', err);
      showMessage('Registration failed: ' + err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const cred = await signInWithEmailAndPassword(auth, email, password);
      const uid = cred.user.uid;
      const userDoc = await getDoc(doc(db, 'users', uid));
      if (!userDoc.exists()) throw new Error('User profile not found.');
      const profile = { uid, ...userDoc.data() };

      if (profile.deviceId && profile.deviceId !== deviceId) {
        setUser(profile);
        setView('device-verify');
        showMessage('New device detected! Admin verification required.', 'warning');
        setLoading(false);
        return;
      }

      if (!profile.deviceId) {
        await updateDoc(doc(db, 'users', uid), { deviceId, deviceVerified: true });
        profile.deviceId = deviceId;
        profile.deviceVerified = true;
      }

      setUser(profile);
      setView(profile.role === 'admin' ? 'admin' : 'attendee');
      if (profile.role === 'admin') subscribeAdminData();
      showMessage(`Welcome back, ${profile.name || profile.email}!`, 'success');
    } catch (err) {
      console.error('Login error:', err);
      showMessage('Login failed: ' + err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
    setUser(null);
    setView('login');
    setEvents([]);
    setAttendanceRecords([]);
    showMessage('Logged out successfully', 'success');
  };

  // ---------- Admin Data & Subscriptions ----------

  const subscribeAdminData = () => {
    const eventsCol = collection(db, 'events');
    eventsUnsub = onSnapshot(eventsCol, (snap) => {
      const arr = [];
      snap.forEach(docSnap => arr.push({ id: docSnap.id, ...docSnap.data() }));
      setEvents(arr);
    });

    const attCol = collection(db, 'attendance');
    attendanceUnsub = onSnapshot(attCol, (snap) => {
      const arr = [];
      snap.forEach(docSnap => arr.push({ id: docSnap.id, ...docSnap.data() }));
      setAttendanceRecords(arr);
    });
  };

  const fetchUserAttendance = async (uid) => {
    try {
      console.log('Fetching attendance for user:', uid);
      const q = query(collection(db, 'attendance'), where('userId', '==', uid));
      const snap = await getDocs(q);
      const arr = [];
      snap.forEach(docSnap => arr.push({ id: docSnap.id, ...docSnap.data() }));
      console.log('Found attendance records:', arr.length);
      setAttendanceRecords(arr);
    } catch (err) {
      console.error('fetchUserAttendance err:', err);
      setMessage({ type: 'error', text: 'Failed to load attendance records.' });
    }
  };

  // ---------- Admin: Create Event & QR ----------

  const handleCreateEvent = async (e) => {
    e.preventDefault();
    setLoading(true);
    setMessage({ text: '', type: '' });

    try {
      const eventId = crypto?.randomUUID ? crypto.randomUUID() : ('evt_' + Date.now());
      const eventPayload = {
        name: eventName.trim(),
        startTime: serverTimestamp ? new Date(startTime) : new Date(startTime),
        endTime: serverTimestamp ? new Date(endTime) : new Date(endTime),
        createdBy: user.uid,
        createdAt: serverTimestamp(),
        active: true,
        attendeeCount: 0
      };

      await setDoc(doc(db, 'events', eventId), eventPayload);

      // Create signed QR payload
      const qrPayload = {
        eventId,
        expiry: new Date(endTime).toISOString()
      };
      console.log('Creating QR with payload:', qrPayload);
      const encoded = btoa(JSON.stringify(qrPayload));

      // Store the base64 encoded payload for the QR
      setQrData(encoded);

      showMessage('Event created & QR generated!', 'success');
      setEventName('');
      setStartTime('');
      setEndTime('');
    } catch (err) {
      console.error('Error creating event:', err);
      console.error('Event creation stack:', err.stack);
      showMessage('Failed to create event: ' + err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadQR = () => {
    if (!qrData) return;
    const a = document.createElement('a');
    a.href = qrData;
    a.download = `event_qr.png`;
    a.click();
  };

  // ---------- EXPORT: Export Attendance CSV (added) ----------
  const exportAttendance = async (event) => {
    try {
      setLoading(true);
      const q = query(collection(db, 'attendance'), where('eventId', '==', event.id));
      const snap = await getDocs(q);

      // Build rows with proper CSV escaping
      const rows = [
        ['Name', 'Email', 'Check-in Time', 'Latitude', 'Longitude', 'Accuracy (m)']
      ];

      snap.forEach(docSnap => {
        const a = docSnap.data();
        rows.push([
          a.userName || '',
          a.userEmail || '',
          a.checkedInAt || (a.timestamp ? (a.timestamp.toDate ? a.timestamp.toDate().toISOString() : String(a.timestamp)) : ''),
          a.location?.lat ?? '',
          a.location?.lng ?? '',
          a.location?.accuracy ?? ''
        ]);
      });

      const csv = rows.map(row => row
        .map(cell => `"${String(cell).replace(/"/g, '""')}"`)
        .join(',')
      ).join('\n');

      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;

      const filenameSafe = (event.name || event.id).replace(/\s+/g, '_').replace(/[^\w\-_.]/g, '');
      a.download = `${filenameSafe}_attendance.csv`;
      a.click();
      URL.revokeObjectURL(url);
      showMessage('Export ready — download started.', 'success');
    } catch (err) {
      console.error('exportAttendance error:', err);
      showMessage('Export failed: ' + err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  // ---------- Attendee: Scan & Mark Attendance ----------
  // NOTE: this function now accepts either an event (form submit) or a direct scanned code (string)
  const handleScanAttendance = async (eOrCode) => {
    setLoading(true);
    setMessage({ text: '', type: '' });

    let isScannerCall = false;
    let code = '';

    if (typeof eOrCode === 'string') {
      // called from scanner with scanned code
      isScannerCall = true;
      code = eOrCode;
    } else {
      // called from form submit
      try { eOrCode.preventDefault(); } catch (e) { }
      code = scanInput.trim();
    }

    try {
      console.log('Starting attendance marking with input:', code);
      const raw = code;
      if (!raw) {
        setMessage({ type: 'error', text: 'QR code is required.' });
        setLoading(false);
        return;
      }
      if (!location) {
        setMessage({ type: 'error', text: 'Enable location before submitting.' });
        setLoading(false);
        return;
      }

      // First try: Treat input as full URL and extract data parameter
      let cleanedRaw = raw;
      try {
        if (raw.includes('api.qrserver.com')) {
          const url = new URL(raw);
          cleanedRaw = url.searchParams.get('data') || raw;
          console.log('Extracted data from URL:', cleanedRaw);
        }
      } catch (e) {
        console.log('Not a URL, using raw input');
      }

      // Decode QR payload. Support two formats:
      // 1) base64-encoded JSON: { eventId, expiry }
      // 2) plain eventId string (legacy/simple)
      let eventId = null;
      let expiry = null;
      try {
        console.log('Attempting to decode QR payload:', cleanedRaw);
        const decoded = JSON.parse(atob(cleanedRaw));
        console.log('Successfully decoded JSON:', decoded);
        eventId = decoded.eventId;
        expiry = decoded.expiry || null;
      } catch (err) {
        console.log('Base64 JSON decode failed:', err);
        console.log('Treating as plain eventId');
        // Not base64 JSON — treat raw as plain eventId
        eventId = cleanedRaw;
        expiry = null;
      }

      if (!eventId) {
        console.error('No eventId found in payload');
        setMessage({ type: 'error', text: 'Malformed QR code.' });
        setLoading(false);
        return;
      }

      // Validate user context
      if (!user || !user.uid) {
        console.error('No user context found:', { user });
        setMessage({ type: 'error', text: 'Please log in again.' });
        setLoading(false);
        return;
      }

      console.log('Checking event:', eventId);
      if (expiry && new Date(expiry) < new Date()) {
        setMessage({ type: 'error', text: 'This QR code has expired.' });
        setLoading(false);
        return;
      }

      // Firebase operations wrapped in try-catch
      let eventData;
      try {
        const eventRef = doc(db, 'events', eventId);
        const eventSnap = await getDoc(eventRef);
        console.log('Event lookup result:', { exists: eventSnap.exists() });

        if (!eventSnap.exists()) {
          setMessage({ type: 'error', text: 'Event not found or invalid QR.' });
          setLoading(false);
          return;
        }
        eventData = eventSnap.data();
        console.log('Event data:', eventData);
      } catch (dbErr) {
        console.error('Firebase event lookup failed:', dbErr);
        setMessage({ type: 'error', text: 'Database error: ' + dbErr.message });
        setLoading(false);
        return;
      }

      // Time window check (if stored as timestamp objects or Date)
      if (eventData.endTime && eventData.endTime.toDate && new Date(eventData.endTime.toDate()) < new Date()) {
        setMessage({ type: 'error', text: 'Event has ended — cannot mark now.' });
        setLoading(false);
        return;
      }
      if (eventData.startTime && eventData.startTime.toDate && new Date(eventData.startTime.toDate()) > new Date()) {
        setMessage({ type: 'error', text: 'Event not yet started.' });
        setLoading(false);
        return;
      }

      // Duplicate attendance check
      const attQuery = query(
        collection(db, 'attendance'),
        where('userId', '==', user.uid),
        where('eventId', '==', eventId)
      );
      const attSnap = await getDocs(attQuery);
      if (!attSnap.empty) {
        setMessage({ type: 'warning', text: 'You already marked attendance for this event.' });
        setLoading(false);
        return;
      }

      // Optional proximity check if event has fixedLocation & allowedRadius
      if (eventData.fixedLocation && eventData.allowedRadiusMeters) {
        const d = haversineDistance(
          location.lat, location.lng,
          eventData.fixedLocation.lat, eventData.fixedLocation.lng
        );
        if (d > eventData.allowedRadiusMeters) {
          setMessage({ type: 'error', text: 'You are outside the allowed check-in radius.' });
          setLoading(false);
          return;
        }
      }

      // Create attendance record with detailed logging
      console.log('Creating attendance record for:', {
        eventId,
        userId: user.uid,
        location: location
      });

      try {
        const attendanceRef = doc(collection(db, 'attendance'));
        const attendanceData = {
          eventId,
          userId: user.uid,
          userName: user.name || '',
          userEmail: user.email || '',
          timestamp: serverTimestamp(),
          deviceInfo: { deviceId, userAgent: navigator.userAgent },
          location: {
            lat: location.lat,
            lng: location.lng,
            accuracy: location.accuracy || 0
          },
          checkedInAt: new Date().toISOString(),
          status: 'present'
        };

        console.log('Attendance data to save:', attendanceData);
        await setDoc(attendanceRef, attendanceData);
        console.log('Attendance record saved successfully');

        showMessage('Attendance marked successfully!', 'success');
        setScanInput('');
      } catch (dbErr) {
        console.error('Failed to save attendance:', dbErr);
        throw new Error('Failed to save attendance: ' + dbErr.message);
      }

      // Optionally increment count
      try {
        const evRef = doc(db, 'events', eventId);
        const newCount = (eventData.attendeeCount || 0) + 1;
        await updateDoc(evRef, { attendeeCount: newCount });
      } catch (err) {
        console.warn('Could not increment attendeeCount:', err);
      }

      showMessage(`Attendance marked for ${eventData.name}!`, 'success');
      setScanInput('');
    } catch (err) {
      console.error('Error while marking attendance:', err);
      console.error('Full error details:', {
        error: err,
        stack: err.stack,
        user: user?.uid,
        location: location ? 'present' : 'missing'
      });
      let errorMsg = 'Error marking attendance.';
      if (err.code === 'permission-denied') {
        errorMsg = 'Permission denied. Please check your login status.';
      } else if (err.code === 'not-found') {
        errorMsg = 'Event not found. Please check the QR code.';
      }
      setMessage({ type: 'error', text: errorMsg });
    } finally {
      setLoading(false);
      // if scanner triggered and we closed scanner, ensure cameraOpen false
      if (isScannerCall) setCameraOpen(false);
    }
  };

  // ---------- Render UI (your original UI preserved) ----------
  if (view === 'login') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-8 border border-gray-100">
          <div className="flex items-center justify-center mb-6">
            <div className="p-3 bg-indigo-100 rounded-full">
              <QrCode className="w-12 h-12 text-indigo-600" />
            </div>
          </div>
          <h1 className="text-3xl font-bold text-center text-gray-800 mb-2">Attendance System</h1>
          <p className="text-center text-gray-600 mb-8">Secure QR-based attendance tracking</p>

          {message.text && (
            <div className={`p-4 rounded-lg mb-4 flex items-center gap-2 ${message.type === 'success' ? 'bg-green-50 text-green-800 border border-green-200' :
              message.type === 'error' ? 'bg-red-50 text-red-800 border border-red-200' :
                'bg-yellow-50 text-yellow-800 border border-yellow-200'
              }`}>
              {message.type === 'success' ? <CheckCircle className="w-5 h-5" /> :
                message.type === 'error' ? <XCircle className="w-5 h-5" /> :
                  <AlertCircle className="w-5 h-5" />}
              <span className="text-sm">{message.text}</span>
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
                placeholder="you@example.com"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
                placeholder="••••••••"
                required
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-indigo-600 text-white py-3 rounded-lg font-semibold hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed shadow-lg"
            >
              {loading ? 'Logging in...' : 'Login'}
            </button>
          </form>

          <div className="mt-6 text-center">
            <button
              onClick={() => setView('register')}
              className="text-indigo-600 hover:text-indigo-700 font-medium text-sm"
            >
              Don’t have an account? <span className="underline">Register here</span>
            </button>
          </div>

          <div className="mt-6 pt-6 border-t border-gray-200">
            <div className="flex items-center justify-between text-xs text-gray-500">
              <div className="flex items-center gap-2">
                <Shield className="w-4 h-4" />
                <span>Device: {deviceId.slice(0, 8)}…</span>
              </div>
              {location && (
                <div className="flex items-center gap-1 text-green-600">
                  <MapPin className="w-3 h-3" />
                  <span>Location enabled</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (view === 'register') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-8 border border-gray-100">
          <h1 className="text-3xl font-bold text-center text-gray-800 mb-8">Create Account</h1>

          {message.text && (
            <div className={`p-4 rounded-lg mb-4 flex items-center gap-2 ${message.type === 'success' ? 'bg-green-50 text-green-800 border border-green-200' :
              message.type === 'error' ? 'bg-red-50 text-red-800 border border-red-200' :
                'bg-yellow-50 text-yellow-800 border border-yellow-200'
              }`}>
              {message.type === 'success' ? <CheckCircle className="w-5 h-5" /> :
                message.type === 'error' ? <XCircle className="w-5 h-5" /> :
                  <AlertCircle className="w-5 h-5" />}
              <span className="text-sm">{message.text}</span>
            </div>
          )}

          <form onSubmit={handleRegister} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
                placeholder="John Doe"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
                placeholder="you@example.com"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
                placeholder="••••••••"
                minLength={6}
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
              <select
                value={role}
                onChange={e => setRole(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
              >
                <option value="attendee">Attendee</option>
                <option value="admin">Admin / Organizer</option>
              </select>
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-indigo-600 text-white py-3 rounded-lg font-semibold hover:bg-indigo-700 transition disabled:opacity-50 shadow-lg"
            >
              {loading ? 'Creating Account...' : 'Register'}
            </button>
          </form>

          <div className="mt-6 text-center">
            <button
              onClick={() => setView('login')}
              className="text-indigo-600 hover:text-indigo-700 font-medium text-sm"
            >
              Already have an account? <span className="underline">Login here</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (view === 'device-verify') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-yellow-50 to-orange-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-8">
          <div className="flex items-center justify-center mb-6">
            <div className="p-4 bg-orange-100 rounded-full">
              <Shield className="w-16 h-16 text-orange-600" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-center text-gray-800 mb-4">New Device Detected</h1>
          <p className="text-center text-gray-600 mb-8">
            For security, admin verification is required on this new device.
          </p>
          <div className="bg-orange-50 border border-orange-200 rounded-lg p-4 mb-6">
            <p className="text-sm text-orange-800">
              <strong>Your Device ID:</strong><br />
              <code className="text-xs font-mono">{deviceId}</code>
            </p>
          </div>
          <button
            onClick={async () => {
              await updateDoc(doc(db, 'users', user.uid), { deviceId, deviceVerified: true });
              const upd = (await getDoc(doc(db, 'users', user.uid))).data();
              setUser({ uid: user.uid, ...upd });
              showMessage('Device verified!', 'success');
              setView(user.role === 'admin' ? 'admin' : 'attendee');
            }}
            className="w-full bg-orange-600 text-white py-3 rounded-lg font-semibold hover:bg-orange-700 transition"
          >
            Verify & Continue
          </button>
          <div className="mt-6 text-center">
            <button
              onClick={() => setView('login')}
              className="text-gray-600 hover:text-gray-700 text-sm"
            >
              Back to Login
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (view === 'admin') {
    return (
      <div className="min-h-screen bg-gray-50">
        <header className="bg-white shadow-sm border-b border-gray-200">
          <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-indigo-100 rounded-lg">
                <Calendar className="w-6 h-6 text-indigo-600" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-gray-800">Admin Dashboard</h1>
                <p className="text-sm text-gray-500">{user?.name} - {user?.email}</p>
              </div>
            </div>
            <button
              onClick={handleLogout}
              className="flex items-center gap-2 px-4 py-2 bg-red-50 text-red-600 rounded-lg hover:bg-red-100 transition border border-red-200"
            >
              <LogOut className="w-4 h-4" />
              <span className="font-medium">Logout</span>
            </button>
          </div>
        </header>
        <main className="max-w-7xl mx-auto px-4 py-8">
          {message.text && (
            <div className={`p-4 rounded-lg mb-6 flex items-center gap-2 ${message.type === 'success' ? 'bg-green-50 text-green-800 border border-green-200' :
              message.type === 'error' ? 'bg-red-50 text-red-800 border border-red-200' :
                'bg-yellow-50 text-yellow-800 border border-yellow-200'
              }`}>
              {message.type === 'success' ? <CheckCircle className="w-5 h-5" /> :
                message.type === 'error' ? <XCircle className="w-5 h-5" /> :
                  <AlertCircle className="w-5 h-5" />}
              <span className="text-sm font-medium">{message.text}</span>
            </div>
          )}

          <div className="grid md:grid-cols-2 gap-6 mb-6">
            <div className="bg-white rounded-xl shadow-sm p-6 border border-gray-200">
              <h2 className="text-xl font-bold text-gray-800 mb-4 flex items-center gap-2">
                <Calendar className="w-6 h-6 text-indigo-600" />
                Create Event
              </h2>
              <form onSubmit={handleCreateEvent} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Event Name</label>
                  <input
                    type="text"
                    value={eventName}
                    onChange={e => setEventName(e.target.value)}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                    placeholder="Event title"
                    required
                  />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Start Time</label>
                    <input
                      type="datetime-local"
                      value={startTime}
                      onChange={e => setStartTime(e.target.value)}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">End Time</label>
                    <input
                      type="datetime-local"
                      value={endTime}
                      onChange={e => setEndTime(e.target.value)}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                      required
                    />
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-indigo-600 text-white py-3 rounded-lg font-semibold hover:bg-indigo-700 transition disabled:opacity-50"
                >
                  {loading ? 'Creating Event...' : 'Create Event & Generate QR'}
                </button>
              </form>
              {qrData && (
                <div className="mt-8 text-center">
                  <h3 className="text-lg font-semibold text-gray-800 mb-4">Generated QR</h3>
                  <div className="flex justify-center">
                    <img
                      src={`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${qrData}`}
                      alt="Event QR"
                      className="w-56 h-56" />
                  </div>
                  <p className="text-sm text-gray-500 mt-3">Use this QR for attendees</p>
                  <button
                    onClick={handleDownloadQR}
                    className="mt-4 inline-flex items-center gap-2 bg-green-50 text-green-700 border border-green-200 px-4 py-2 rounded-lg hover:bg-green-100"
                  >
                    <Download className="w-4 h-4" />
                    Download QR
                  </button>
                </div>
              )}
            </div>
            <div className="bg-white rounded-xl shadow-sm p-6 border border-gray-200">
              <h2 className="text-xl font-bold text-gray-800 mb-4 flex items-center gap-2">
                <Users className="w-6 h-6 text-indigo-600" />
                Active Events ({events.length})
              </h2>
              {events.length === 0 ? (
                <div className="text-center py-12">
                  <Calendar className="w-16 h-16 text-gray-300 mx-auto mb-3" />
                  <p className="text-gray-500">No events available.</p>
                  <p className="text-sm text-gray-400 mt-1">Create one to begin</p>
                </div>
              ) : (
                <div className="space-y-4 max-h-96 overflow-y-auto">
                  {events.map(evt => (
                    <div key={evt.id} className="border border-gray-200 rounded-lg p-4 hover:shadow-md transition">
                      <div className="flex items-start justify-between mb-2">
                        <div className="flex-1">
                          <h3 className="font-semibold text-gray-800">{evt.name}</h3>
                        </div>
                        <button
                          onClick={() => {
                            exportAttendance(evt);
                          }}
                          className="p-2 text-indigo-600 hover:bg-indigo-50 rounded-lg transition"
                          title="Export Attendance"
                        >
                          <Download className="w-4 h-4" />
                        </button>
                      </div>
                      <p className="text-xs text-gray-500 mb-2">
                        {evt.startTime ? (evt.startTime.toDate ? new Date(evt.startTime.toDate()).toLocaleString() : new Date(evt.startTime).toLocaleString()) : ''} — {evt.endTime ? (evt.endTime.toDate ? new Date(evt.endTime.toDate()).toLocaleString() : new Date(evt.endTime).toLocaleString()) : ''}
                      </p>
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-indigo-600">
                          {evt.attendeeCount || 0} attendees
                        </span>
                      </div>
                      <div className="mt-3 p-3 bg-gray-50 rounded border border-gray-200">
                        <p className="text-xs text-gray-500 mb-1">QR Payload:</p>
                        <p className="text-xs font-mono text-gray-700 break-all select-all">{evt.id}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (view === 'attendee') {
    return (
      <div className="min-h-screen bg-gray-50">
        <header className="bg-white shadow-sm border-b border-gray-200">
          <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-indigo-100 rounded-lg">
                <Camera className="w-6 h-6 text-indigo-600" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-gray-800">Mark Attendance</h1>
                <p className="text-sm text-gray-500">{user?.name} — {user?.email}</p>
              </div>
            </div>
            <button
              onClick={handleLogout}
              className="flex items-center gap-2 px-4 py-2 bg-red-50 text-red-600 rounded-lg hover:bg-red-100 transition border border-red-200"
            >
              <LogOut className="w-4 h-4" />
              <span className="font-medium">Logout</span>
            </button>
          </div>
        </header>

        <main className="max-w-2xl mx-auto px-4 py-8">
          {message.text && (
            <div className={`p-4 rounded-lg mb-6 flex items-center gap-2 ${message.type === 'success' ? 'bg-green-50 text-green-800 border border-green-200' :
              message.type === 'error' ? 'bg-red-50 text-red-800 border border-red-200' :
                'bg-yellow-50 text-yellow-800 border border-yellow-200'
              }`}>
              {message.type === 'success' ? <CheckCircle className="w-5 h-5" /> :
                message.type === 'error' ? <XCircle className="w-5 h-5" /> :
                  <AlertCircle className="w-5 h-5" />}
              <span className="text-sm">{message.text}</span>
            </div>
          )}

          <div className="bg-white rounded-xl shadow-sm p-8 border border-gray-200">
            <div className="flex items-center justify-center mb-6">
              <div className="w-24 h-24 bg-indigo-100 rounded-full flex items-center justify-center">
                <QrCode className="w-12 h-12 text-indigo-600" />
              </div>
            </div>
            <h2 className="text-2xl font-bold text-center text-gray-800 mb-2">Scan or Enter QR</h2>
            <p className="text-center text-gray-600 mb-8">
              Use the QR code given by admin to mark attendance
            </p>

            <form onSubmit={handleScanAttendance} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">QR Code</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={scanInput}
                    onChange={e => setScanInput(e.target.value)}
                    placeholder="Paste or scan QR"
                    className="flex-1 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-lg outline-none"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setCameraOpen(true)}
                    className="inline-flex items-center gap-2 px-3 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition"
                    title="Open camera scanner"
                  >
                    <Camera className="w-5 h-5" />
                    <span className="sr-only">Open Scanner</span>
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-indigo-600 text-white py-4 rounded-lg font-semibold hover:bg-indigo-700 transition disabled:opacity-50 text-lg shadow-lg"
              >
                {loading ? 'Marking...' : 'Mark Attendance'}
              </button>
            </form>

            {/* Show recent attendance records */}
            {attendanceRecords.length > 0 && (
              <div className="mt-6 border-t border-gray-200 pt-6">
                <h3 className="text-sm font-medium text-gray-700 mb-3">Your Recent Attendance:</h3>
                <div className="space-y-2">
                  {attendanceRecords.slice(0, 3).map(record => (
                    <div key={record.id} className="bg-gray-50 p-3 rounded-lg text-sm">
                      <div className="font-medium text-gray-900">
                        {new Date(record.checkedInAt).toLocaleDateString()}
                      </div>
                      <div className="text-gray-500">{record.status}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {cameraOpen && (
              // Scanner overlay (simple modal style)
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
                <div className="bg-white rounded-xl p-4 w-full max-w-md">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-lg font-semibold">Scan QR</h3>
                    <button
                      onClick={() => setCameraOpen(false)}
                      className="text-gray-600 hover:text-gray-900"
                    >
                      Close
                    </button>
                  </div>

                  <div className="rounded overflow-hidden">
                    <QrReader
                      constraints={{ facingMode: 'environment' }}
                      onResult={(result, error) => {
                        if (!!result?.text) {
                          const text = result.text;
                          // set value in input and auto-submit
                          setScanInput(text);
                          // call handler with scanned string
                          handleScanAttendance(text);
                        } else {
                          if (error) {
                            // occasionally will receive decode errors; ignore silently
                            // console.debug('QR read error', error);
                          }
                        }
                      }}
                      containerStyle={{ width: '100%' }}
                      videoStyle={{ width: '100%' }}
                    />
                  </div>

                  <p className="text-sm text-gray-500 mt-3">If scanning fails, paste the QR data into the input above and submit manually.</p>
                </div>
              </div>
            )}

            <div className="mt-8 pt-6 border-t border-gray-200">
              {location ? (
                <div className="flex items-start gap-3 text-sm text-gray-600">
                  <MapPin className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium text-gray-800 mb-1">Location Enabled</p>
                    <p>Lat: {location.lat.toFixed(6)}</p>
                    <p>Lng: {location.lng.toFixed(6)}</p>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-3 text-sm text-gray-600">
                  <AlertCircle className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5" />
                  <p>Location access not enabled. Please allow it for accurate tracking.</p>
                </div>
              )}
            </div>
          </div>

          <div className="mt-6 bg-blue-50 rounded-xl p-6 border border-blue-200">
            <h3 className="font-semibold text-blue-900 mb-2">How to use:</h3>
            <ol className="text-sm text-blue-800 space-y-1 list-decimal list-inside">
              <li>Get the event QR from admin</li>
              <li>Scan or paste it above</li>
              <li>Your location is captured automatically</li>
              <li>Submit to mark your attendance</li>
            </ol>
          </div>
        </main>
      </div>
    );
  }

  return null;
};

export default AttendanceSystem;
