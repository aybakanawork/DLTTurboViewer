import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Search, FileText, Zap, Clock, Info, X, ChevronDown, AlertTriangle } from 'lucide-react';

const LARGE_FILE_LIMIT = 50 * 1024 * 1024; // 50MB
const PAGE_SIZE = 100; // Virtualized pagination chunk size
const PARSE_TIMEOUT_MS = 30000; // 30 second timeout for parsing

export default function App() {
  const [logs, setLogs] = useState([]);
  const [status, setStatus] = useState('No data');
  const [loading, setLoading] = useState(false);
  const [showRangeSelector, setShowRangeSelector] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [fileBuffer, setFileBuffer] = useState(null);
  const [timeline, setTimeline] = useState({ start: 0, end: 0 });
  const [selectedStart, setSelectedStart] = useState(0);
  const [selectedEnd, setSelectedEnd] = useState(0);
  const [selectedLog, setSelectedLog] = useState(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [error, setError] = useState(null);

  const workerRef = useRef(null);

  // Reset pagination when search changes
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [searchTerm]);

  const formatTime = (ts) => {
    if (!ts) return "00:00:00";
    try {
      return new Date(ts * 1000).toISOString().substr(11, 8);
    } catch (e) {
      return "00:00:00";
    }
  };

  const fastScanTimeline = (buffer) => {
    const data = new DataView(buffer);
    let start = 0, end = 0;
    
    const isDltHeader = (dv, offset) => {
      return offset + 4 <= dv.byteLength &&
             dv.getUint8(offset) === 68 && 
             dv.getUint8(offset+1) === 76 && 
             dv.getUint8(offset+2) === 84 && 
             dv.getUint8(offset+3) === 1;
    };

    for (let i = 0; i < Math.min(buffer.byteLength, 100000); i++) {
      if (isDltHeader(data, i)) {
        start = data.getUint32(i + 4, true);
        break;
      }
    }
    for (let i = buffer.byteLength - 20; i > Math.max(0, buffer.byteLength - 200000); i--) {
      if (isDltHeader(data, i)) {
        end = data.getUint32(i + 4, true);
        break;
      }
    }
    return { start, end };
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setError(null);
    setLoading(true);
    const buffer = await file.arrayBuffer();
    setFileBuffer(buffer);
    
    const meta = fastScanTimeline(buffer);
    setTimeline(meta);

    if (buffer.byteLength > LARGE_FILE_LIMIT && meta.start > 0) {
      setSelectedStart(meta.start);
      setSelectedEnd(meta.end);
      setShowRangeSelector(true);
      setLoading(false);
    } else {
      startParsing(buffer);
    }
  };

  const startParsing = (buffer, range = null) => {
    if (!buffer) return;
    setLoading(true);
    setShowRangeSelector(false);
    setError(null);
    setLogs([]);

    const workerCode = `
      onmessage = function(e) {
        const { buffer, range } = e.data;
        const data = new DataView(buffer);
        const logs = [];
        let offset = 0;

        function cleanString(dv, off, len) {
          let str = "";
          for(let i=0; i<len; i++) {
            const b = dv.getUint8(off + i);
            if(b >= 32 && b <= 126) str += String.fromCharCode(b);
          }
          return str.trim();
        }

        while (offset < buffer.byteLength) {
          // Look for DLT Storage Header "DLT\\x01"
          if (offset + 16 <= buffer.byteLength && 
              data.getUint8(offset) === 68 && 
              data.getUint8(offset+1) === 76 && 
              data.getUint8(offset+2) === 84 &&
              data.getUint8(offset+3) === 1) {
              
              const timestamp = data.getUint32(offset + 4, true);
              const headerOffset = offset + 16;
              
              const tooEarly = range && timestamp < range.start;
              const tooLate = range && timestamp > range.end;

              if (tooLate) break;

              // Read Standard Header
              if (headerOffset + 4 <= buffer.byteLength) {
                const headerCtrl = data.getUint8(headerOffset);
                const msb = (headerCtrl & 0x02) !== 0; // If Bit 1 is set, Big Endian. But DLT is usually little for headers.
                const length = data.getUint16(headerOffset + 2, false); // Length is usually Big Endian in Std Header
                const nextMessageOffset = headerOffset + length;

                if (!tooEarly && length > 4) {
                  const hasEcu = (headerCtrl & 0x04) !== 0;
                  const hasExt = (headerCtrl & 0x01) !== 0;
                  
                  let ecu = "N/A";
                  let cur = headerOffset + 4;
                  
                  // Counter (1 byte) + Length (2 bytes) + Header Ctrl (1 byte) = 4 bytes already read
                  if (hasEcu && cur + 4 <= buffer.byteLength) {
                    ecu = cleanString(data, cur, 4);
                    cur += 4;
                  }
                  
                  // Skip Session ID if exists (Bit 4)
                  if ((headerCtrl & 0x10) !== 0) cur += 4;
                  // Skip Timestamp if exists (Bit 5)
                  if ((headerCtrl & 0x20) !== 0) cur += 4;

                  let app = "-";
                  if (hasExt && cur + 10 <= buffer.byteLength) {
                    // Extended Header: MSB (1 byte) + Arguments (1 byte) + AppID (4 bytes) + ContextID (4 bytes)
                    cur += 2; // skip MSB and Args
                    app = cleanString(data, cur, 4);
                  }

                  let p = "";
                  // Payload extraction - look further ahead to skip metadata
                  const pOffset = cur + (hasExt ? 8 : 0); 
                  if (pOffset < headerOffset + length) {
                    const pLen = Math.min(256, (headerOffset + length) - pOffset);
                    for(let i=0; i < pLen; i++) {
                      if (pOffset + i >= buffer.byteLength) break;
                      const b = data.getUint8(pOffset + i);
                      if(b >= 32 && b <= 126) p += String.fromCharCode(b);
                      else if (b === 10 || b === 13) p += " ";
                    }
                  }

                  logs.push({
                    time: new Date(timestamp * 1000).toISOString().substr(11, 8),
                    ecu: ecu || "N/A",
                    app: app || "-",
                    payload: p.trim(),
                    id: logs.length + 1
                  });
                }
                offset = nextMessageOffset;
                continue;
              }
          }
          offset++; 
        }
        postMessage(logs);
      };
    `;

    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const worker = new Worker(URL.createObjectURL(blob));
    workerRef.current = worker;

    const timeoutId = setTimeout(() => {
      if (workerRef.current) {
        workerRef.current.terminate();
        setLoading(false);
        setError("Parsing timed out. Please select a smaller time range or ensure the file is a valid DLT.");
        setShowRangeSelector(true);
      }
    }, PARSE_TIMEOUT_MS);

    worker.onmessage = (e) => {
      clearTimeout(timeoutId);
      setLogs(e.data);
      setLoading(false);
      setStatus(range ? "Custom Range" : "Full File");
      worker.terminate();
      workerRef.current = null;
    };

    worker.onerror = (err) => {
      clearTimeout(timeoutId);
      setLoading(false);
      setError("An error occurred while parsing the file binary stream.");
      worker.terminate();
      workerRef.current = null;
    };

    worker.postMessage({ buffer, range });
  };

  const filteredLogs = useMemo(() => {
    if (!searchTerm) return logs;
    const s = searchTerm.toLowerCase();
    return logs.filter(l => 
      l.payload.toLowerCase().includes(s) || 
      l.ecu.toLowerCase().includes(s) || 
      l.app.toLowerCase().includes(s)
    );
  }, [logs, searchTerm]);

  const displayLogs = useMemo(() => {
    return filteredLogs.slice(0, visibleCount);
  }, [filteredLogs, visibleCount]);

  const handleScroll = useCallback((e) => {
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
    if (scrollHeight - scrollTop <= clientHeight + 150) {
      if (visibleCount < filteredLogs.length) {
        setVisibleCount(prev => prev + PAGE_SIZE);
      }
    }
  }, [visibleCount, filteredLogs.length]);

  return (
    <div className="h-screen flex flex-col bg-slate-50 text-slate-900 overflow-hidden font-sans">
      <header className="bg-slate-900 text-white p-4 flex justify-between items-center shadow-lg z-20">
        <div className="flex items-center space-x-3">
          <div className="bg-blue-600 p-2 rounded-xl shadow-inner">
            <Zap className="w-5 h-5 text-white" fill="currentColor" />
          </div>
          <h1 className="text-xl font-bold tracking-tight">DLT <span className="text-blue-400">Turbo</span></h1>
        </div>
        
        <div className="flex items-center space-x-4">
          <label className="cursor-pointer bg-white/10 hover:bg-white/20 text-white px-4 py-2 rounded-lg transition text-sm font-medium border border-white/10">
            Open File
            <input type="file" onChange={handleFileUpload} className="hidden" accept=".dlt" />
          </label>
          <div className="px-3 py-1 bg-black/20 rounded font-mono text-[10px] text-slate-400 border border-white/5">
            {status}
          </div>
        </div>
      </header>

      <div className="bg-white border-b p-2 flex gap-4 items-center px-6 shadow-sm z-10">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
          <input 
            type="text" 
            placeholder="Search all records..." 
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 text-sm bg-slate-100 border-none rounded-lg focus:ring-2 focus:ring-blue-500 transition-all outline-none"
          />
        </div>
        <div className="h-6 w-px bg-slate-200" />
        <div className="flex items-center space-x-2">
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Found</span>
          <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded text-xs font-bold">
            {filteredLogs.length.toLocaleString()}
          </span>
          {searchTerm && (
            <span className="text-[10px] text-slate-400 italic">of {logs.length.toLocaleString()} total</span>
          )}
        </div>
      </div>

      <main className="flex-1 overflow-hidden relative">
        <div className="h-full overflow-auto custom-scrollbar bg-white" onScroll={handleScroll}>
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 bg-slate-50 z-10 shadow-sm">
              <tr className="text-slate-500 font-bold uppercase text-[10px] tracking-wider">
                <th className="px-4 py-3 border-b w-16">#</th>
                <th className="px-4 py-3 border-b w-28">Timestamp</th>
                <th className="px-4 py-3 border-b w-24">ECU</th>
                <th className="px-4 py-3 border-b w-24">App</th>
                <th className="px-4 py-3 border-b">Payload</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 font-mono text-[11px]">
              {displayLogs.map((log) => (
                <tr key={log.id} onClick={() => setSelectedLog(log)} className="hover:bg-blue-50/50 cursor-pointer transition-colors group">
                  <td className="px-4 py-2 text-slate-400 group-hover:text-blue-400">{log.id}</td>
                  <td className="px-4 py-2 text-slate-500">{log.time}</td>
                  <td className="px-4 py-2 font-bold text-slate-700">{log.ecu}</td>
                  <td className="px-4 py-2 text-blue-600 font-semibold">{log.app}</td>
                  <td className="px-4 py-2 text-slate-600 truncate max-w-2xl">{log.payload}</td>
                </tr>
              ))}
            </tbody>
          </table>
          
          {displayLogs.length < filteredLogs.length && (
            <div className="p-8 text-center bg-slate-50/50">
              <div className="flex items-center justify-center space-x-2 text-slate-400 text-xs animate-pulse">
                <ChevronDown className="w-4 h-4" />
                <span>Scroll to load more ({filteredLogs.length - displayLogs.length} left)</span>
              </div>
            </div>
          )}

          {logs.length === 0 && !loading && (
            <div className="h-full flex flex-col items-center justify-center text-slate-300 py-20">
              <FileText className="w-16 h-16 mb-2 opacity-20" />
              <p className="text-sm font-medium">No records found. Open a .dlt file to begin.</p>
            </div>
          )}
        </div>

        {showRangeSelector && (
          <div className="absolute inset-0 z-50 bg-slate-900/90 backdrop-blur-sm flex items-center justify-center p-6 overflow-y-auto">
            <div className="bg-white rounded-3xl shadow-2xl max-w-2xl w-full p-8 my-auto">
              <div className="flex items-center justify-between mb-8">
                <div className="flex items-center space-x-4">
                  <div className="bg-blue-100 text-blue-600 p-3 rounded-2xl">
                    <Clock className="w-8 h-8" />
                  </div>
                  <div>
                    <h2 className="text-2xl font-black text-slate-800 tracking-tight">Select Range</h2>
                    <p className="text-sm text-slate-500">Parsing large files works best in chunks.</p>
                  </div>
                </div>
                <button onClick={() => setShowRangeSelector(false)} className="p-2 hover:bg-slate-100 rounded-full">
                  <X className="w-6 h-6 text-slate-400" />
                </button>
              </div>

              {error && (
                <div className="mb-8 p-4 bg-red-50 border border-red-100 rounded-2xl flex items-start space-x-3 text-red-700">
                  <AlertTriangle className="w-5 h-5 mt-0.5 flex-shrink-0" />
                  <div className="text-sm font-medium leading-relaxed">{error}</div>
                </div>
              )}

              <div className="space-y-8">
                <div className="grid grid-cols-2 gap-8">
                  <div className="space-y-4">
                    <label className="text-[10px] font-bold text-slate-400 uppercase">Start Time</label>
                    <input 
                      type="range" min={timeline.start} max={timeline.end} value={selectedStart}
                      onChange={(e) => setSelectedStart(parseInt(e.target.value))}
                      className="w-full h-2 bg-slate-100 rounded-full appearance-none cursor-pointer accent-blue-600"
                    />
                    <div className="font-mono text-xl font-bold text-slate-700">{formatTime(selectedStart)}</div>
                  </div>
                  <div className="space-y-4">
                    <label className="text-[10px] font-bold text-slate-400 uppercase">End Time</label>
                    <input 
                      type="range" min={timeline.start} max={timeline.end} value={selectedEnd}
                      onChange={(e) => setSelectedEnd(parseInt(e.target.value))}
                      className="w-full h-2 bg-slate-100 rounded-full appearance-none cursor-pointer accent-red-600"
                    />
                    <div className="font-mono text-xl font-bold text-slate-700">{formatTime(selectedEnd)}</div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                   <button onClick={() => startParsing(fileBuffer)} className="py-4 text-slate-500 font-bold hover:bg-slate-100 rounded-2xl transition">
                    Parse Full File
                  </button>
                  <button onClick={() => { if (selectedStart < selectedEnd) startParsing(fileBuffer, { start: selectedStart, end: selectedEnd }); }}
                    className="py-4 bg-blue-600 hover:bg-blue-700 text-white rounded-2xl font-bold shadow-xl shadow-blue-200 transition-all transform active:scale-95">
                    Confirm Range
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {loading && (
          <div className="absolute inset-0 z-50 bg-white/80 backdrop-blur-[2px] flex flex-col items-center justify-center">
            <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mb-4" />
            <p className="text-sm font-bold text-slate-800 animate-pulse uppercase tracking-widest text-center px-4">Parsing Binary Streams...</p>
          </div>
        )}

        {selectedLog && (
          <div className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[85vh]">
              <div className="p-4 border-b bg-slate-50 flex justify-between items-center">
                <div className="flex items-center space-x-2">
                  <Info className="w-4 h-4 text-blue-600" />
                  <h3 className="font-bold text-slate-800">Log Details</h3>
                </div>
                <button onClick={() => setSelectedLog(null)} className="p-1 hover:bg-slate-200 rounded-full transition">
                  <X className="w-5 h-5 text-slate-400" />
                </button>
              </div>
              <div className="p-8 overflow-auto custom-scrollbar">
                <div className="grid grid-cols-3 gap-4 mb-6">
                   <div className="bg-slate-50 p-4 rounded-2xl">
                    <span className="text-[10px] font-bold text-slate-400 uppercase block">Timestamp</span>
                    <span className="font-mono font-bold text-slate-700">{selectedLog.time}</span>
                   </div>
                   <div className="bg-slate-50 p-4 rounded-2xl">
                    <span className="text-[10px] font-bold text-slate-400 uppercase block">ECU</span>
                    <span className="font-mono font-bold text-slate-700">{selectedLog.ecu}</span>
                   </div>
                   <div className="bg-slate-50 p-4 rounded-2xl">
                    <span className="text-[10px] font-bold text-slate-400 uppercase block">App ID</span>
                    <span className="font-mono font-bold text-blue-600">{selectedLog.app}</span>
                   </div>
                </div>
                <div>
                  <span className="text-[10px] font-bold text-slate-400 uppercase block mb-2">Message Payload</span>
                  <div className="p-6 bg-slate-900 text-green-400 rounded-2xl font-mono text-xs leading-relaxed break-all border-4 border-slate-800 shadow-inner whitespace-pre-wrap">
                    {selectedLog.payload || "[No Readable Data]"}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}