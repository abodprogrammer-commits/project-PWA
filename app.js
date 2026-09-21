// ==========================================
// 1. إعداد قواعد البيانات (IndexedDB)
// ==========================================
const DB_NAME = 'DocScannerPWA_DB';
const DB_VERSION = 2;
const STORE_DOCS = 'scanned_documents';

let db = null;
let currentModalRecord = null;
let applyFilterBW = false;
let rotationDegree = 0;

function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (e) => {
      const dbRef = e.target.result;
      if (!dbRef.objectStoreNames.contains(STORE_DOCS)) {
        const store = dbRef.createObjectStore(STORE_DOCS, { keyPath: 'id', autoIncrement: true });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('category', 'category', { unique: false });
      }
    };

    request.onsuccess = (e) => {
      db = e.target.result;
      resolve(db);
    };

    request.onerror = (e) => reject('خطأ في فتح IndexedDB: ' + e.target.error);
  });
}

async function addRecordToDB(storeName, data) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([storeName], 'readwrite');
    const store = transaction.objectStore(storeName);
    const request = store.add({ 
      ...data, 
      synced: 0, 
      timestamp: new Date().toISOString() 
    });
    request.onsuccess = () => resolve(request.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

async function getAllRecordsFromDB(storeName) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([storeName], 'readonly');
    const store = transaction.objectStore(storeName);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result.reverse());
    request.onerror = (e) => reject(e.target.error);
  });
}

async function deleteRecordFromDB(storeName, id) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([storeName], 'readwrite');
    const store = transaction.objectStore(storeName);
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = (e) => reject(e.target.error);
  });
}

async function clearAllDB(storeName) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([storeName], 'readwrite');
    const store = transaction.objectStore(storeName);
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = (e) => reject(e.target.error);
  });
}

// ==========================================
// 2. مراقبة حالة البطارية (Battery Status API)
// ==========================================
async function initBatteryStatus() {
  const batteryLevelEl = document.getElementById('battery-level');
  const batteryStatusEl = document.getElementById('battery-status');

  if ('getBattery' in navigator) {
    try {
      const battery = await navigator.getBattery();

      function updateBatteryInfo() {
        const level = Math.round(battery.level * 100);
        const isCharging = battery.charging;

        if (batteryLevelEl) batteryLevelEl.innerText = `${level}%`;
        if (batteryStatusEl) {
          batteryStatusEl.innerText = isCharging ? '⚡ جاري الشحن' : '🔋 على البطارية';
        }
      }

      updateBatteryInfo();

      // الاستماع لتغيرات مستوى الشحن والحالة
      battery.addEventListener('levelchange', updateBatteryInfo);
      battery.addEventListener('chargingchange', updateBatteryInfo);
    } catch (e) {
      if (batteryStatusEl) batteryStatusEl.innerText = 'غير متاح';
    }
  } else {
    if (batteryStatusEl) batteryStatusEl.innerText = 'غير مدعوم بالمتصفح';
  }
}

// ==========================================
// 3. تثبيت PWA والإشعارات والمزامنة
// ==========================================
let deferredPrompt = null;
const btnInstallPWA = document.getElementById('btn-install-pwa');

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (btnInstallPWA) btnInstallPWA.classList.remove('hidden');
});

if (btnInstallPWA) {
  btnInstallPWA.addEventListener('click', async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') setStatus('شكرًا لتثبيت التطبيق على جهازك! 🎉');
      deferredPrompt = null;
      btnInstallPWA.classList.add('hidden');
    }
  });
}

async function requestNotificationPermission() {
  if ('Notification' in window) {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      setStatus('تم تفعيل الإشعارات بنجاح! 🔔');
      showLocalNotification('ماسح المستندات Pro', 'التنبيهات مفعلة الآن ومستعدة لإشعارك بالحفظ.');
    } else {
      setStatus('تم رفض إذن الإشعارات.', true);
    }
  } else {
    setStatus('المتصفح لا يدعم الإشعارات.', true);
  }
}

function showLocalNotification(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') {
    navigator.serviceWorker.ready.then((registration) => {
      registration.showNotification(title, {
        body: body,
        icon: 'https://cdn-icons-png.flaticon.com/512/337/337946.png',
        vibrate: [100, 50, 100]
      });
    });
  }
}

async function triggerBackgroundSync() {
  if ('serviceWorker' in navigator && 'SyncManager' in window) {
    try {
      const registration = await navigator.serviceWorker.ready;
      await registration.sync.register('sync-documents');
      setStatus('تم طلب المزامنة في الخلفية بنجاح 🔄');
    } catch (e) {
      setStatus('تم حفظ البيانات محلياً وسيتم المزامنة تلقائياً عند الاتصال.');
    }
  } else {
    setStatus('تم الحفظ أوفلاين على الجهاز.');
  }
  triggerVibration(60);
}

// ==========================================
// 4. الكاميرا والمعالجة والتقاط الصور
// ==========================================
const video = document.getElementById('camera-feed');
const canvas = document.getElementById('snapshot-canvas');
const placeholder = document.getElementById('camera-placeholder');
const statusMsg = document.getElementById('cam-status-msg');
const docTitleInput = document.getElementById('doc-title-input');
const docCategorySelect = document.getElementById('doc-category-select');

const btnStartCam = document.getElementById('btn-start-cam');
const btnToggleTorch = document.getElementById('btn-toggle-torch');
const btnCaptureDoc = document.getElementById('btn-capture-doc');
const btnScanQR = document.getElementById('btn-scan-qr');
const btnClearDB = document.getElementById('btn-clear-db');
const recordsContainer = document.getElementById('records-container');
const filterCategory = document.getElementById('filter-category');

let mediaStream = null;
let track = null;
let isTorchOn = false;

function setStatus(text, isError = false) {
  if (statusMsg) {
    statusMsg.innerText = text;
    statusMsg.className = `text-xs p-2.5 rounded-xl border min-h-[38px] flex items-center ${
      isError ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-slate-50 text-slate-700 border-slate-200'
    }`;
  }
}

document.getElementById('btn-filter-bw')?.addEventListener('click', () => {
  applyFilterBW = !applyFilterBW;
  setStatus(applyFilterBW ? 'تفعيل فلتر أبيض/أسود ⚪🖤' : 'إلغاء الفلتر');
});
document.getElementById('btn-filter-rotate')?.addEventListener('click', () => {
  rotationDegree = (rotationDegree + 90) % 360;
  setStatus(`تدوير المعاينة: ${rotationDegree}°`);
});
document.getElementById('btn-filter-reset')?.addEventListener('click', () => {
  applyFilterBW = false;
  rotationDegree = 0;
  setStatus('تمت إعادة ضبط ألوان الصورة');
});

btnStartCam?.addEventListener('click', async () => {
  try {
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => t.stop());
      mediaStream = null;
      video.classList.add('hidden');
      placeholder.classList.remove('hidden');
      btnStartCam.innerText = '🎬 تشغيل الكاميرا';
      btnCaptureDoc.disabled = true;
      btnScanQR.disabled = true;
      btnToggleTorch.disabled = true;
      btnCaptureDoc.classList.add('opacity-50', 'cursor-not-allowed');
      btnScanQR.classList.add('opacity-50', 'cursor-not-allowed');
      setStatus('تم إيقاف الكاميرا.');
      return;
    }

    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
    });

    video.srcObject = mediaStream;
    video.classList.remove('hidden');
    placeholder.classList.add('hidden');
    btnStartCam.innerText = '⏹️ إيقاف الكاميرا';

    track = mediaStream.getVideoTracks()[0];
    const capabilities = track.getCapabilities ? track.getCapabilities() : {};

    if (capabilities.torch) {
      btnToggleTorch.disabled = false;
      btnToggleTorch.className = "bg-amber-500 hover:bg-amber-600 text-white font-medium py-2.5 px-3 rounded-xl text-xs flex items-center justify-center gap-1.5 transition-all shadow-sm";
    }

    btnCaptureDoc.disabled = false;
    btnScanQR.disabled = false;
    btnCaptureDoc.classList.remove('opacity-50', 'cursor-not-allowed');
    btnScanQR.classList.remove('opacity-50', 'cursor-not-allowed');

    setStatus('الكاميرا تعمل بنجاح!');
    triggerVibration(50);
  } catch (err) {
    setStatus('فشل الوصول للكاميرا. يرجى إعطاء الصلاحية.', true);
  }
});

btnToggleTorch?.addEventListener('click', async () => {
  if (track) {
    try {
      isTorchOn = !isTorchOn;
      await track.applyConstraints({ advanced: [{ torch: isTorchOn }] });
      btnToggleTorch.innerText = isTorchOn ? '💡 إيقاف الفلاش' : '💡 تشغيل الفلاش';
      setStatus(isTorchOn ? 'تم تشغيل الفلاش 💡' : 'تم إيقاف الفلاش');
    } catch (e) {
      setStatus('ميزة الفلاش غير مدعومة.', true);
    }
  }
});

function processAndDrawCanvas() {
  const context = canvas.getContext('2d');
  
  if (rotationDegree % 180 !== 0) {
    canvas.width = video.videoHeight;
    canvas.height = video.videoWidth;
  } else {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }

  context.save();
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate((rotationDegree * Math.PI) / 180);

  if (rotationDegree % 180 !== 0) {
    context.drawImage(video, -video.videoWidth / 2, -video.videoHeight / 2);
  } else {
    context.drawImage(video, -canvas.width / 2, -canvas.height / 2);
  }
  context.restore();

  if (applyFilterBW) {
    const imgData = context.getImageData(0, 0, canvas.width, canvas.height);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      const avg = (d[i] + d[i + 1] + d[i + 2]) / 3;
      const v = avg > 120 ? 255 : 0;
      d[i] = v;
      d[i + 1] = v;
      d[i + 2] = v;
    }
    context.putImageData(imgData, 0, 0);
  }
}

btnCaptureDoc?.addEventListener('click', async () => {
  if (!mediaStream) return;

  processAndDrawCanvas();
  const imageBase64 = canvas.toDataURL('image/jpeg', 0.85);
  const title = docTitleInput.value.trim() || 'مستند ممسوح';
  const category = docCategorySelect.value;

  try {
    await addRecordToDB(STORE_DOCS, {
      type: 'DOCUMENT',
      title: title,
      category: category,
      content: imageBase64
    });

    triggerVibration([100, 50, 100]);
    setStatus('تم التقاط المستند وتطبيقه بنجاح! 📄');
    showLocalNotification('حفظ مستند', `تم حفظ "${title}" في قسم [${category}].`);
    triggerBackgroundSync();
    
    docTitleInput.value = '';
    renderRecordsList();
  } catch (e) {
    setStatus('حدث خطأ أثناء حفظ المستند.', true);
  }
});

btnScanQR?.addEventListener('click', async () => {
  if (!mediaStream) return;

  const context = canvas.getContext('2d');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  
  if (typeof jsQR !== 'undefined') {
    const code = jsQR(imageData.data, imageData.width, imageData.height);

    if (code) {
      triggerVibration(150);
      const title = docTitleInput.value.trim() || 'رمز QR ممسوح';
      const category = docCategorySelect.value;

      await addRecordToDB(STORE_DOCS, {
        type: 'QR_CODE',
        title: title,
        category: category,
        content: code.data
      });

      setStatus(`تم قراءة QR بنجاح: "${code.data}"`);
      showLocalNotification('مسح QR Code', `النص: ${code.data}`);
      triggerBackgroundSync();

      docTitleInput.value = '';
      renderRecordsList();
    } else {
      setStatus('لم يتم العثور على رمز QR.', true);
    }
  }
});

// ==========================================
// 5. عرض الأرشيف والتصفية
// ==========================================
async function renderRecordsList() {
  try {
    const records = await getAllRecordsFromDB(STORE_DOCS);
    const filterVal = filterCategory ? filterCategory.value : 'الكل';
    recordsContainer.innerHTML = '';

    const filtered = filterVal === 'الكل' ? records : records.filter(r => r.category === filterVal);

    if (filtered.length === 0) {
      recordsContainer.innerHTML = '<p class="text-xs text-slate-400 text-center py-4">لا توجد مستندات مسجلة ضمن هذا التصنيف.</p>';
      return;
    }

    filtered.forEach((record) => {
      const card = document.createElement('div');
      card.className = "p-3 bg-slate-50 border border-slate-200 rounded-2xl flex items-center justify-between gap-2 text-xs hover:border-indigo-300 transition-all";

      const isDoc = record.type === 'DOCUMENT';
      const dateStr = new Date(record.timestamp).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' });

      card.innerHTML = `
        <div class="flex items-center gap-2.5 overflow-hidden">
          <div class="p-2 rounded-xl ${isDoc ? 'bg-indigo-100 text-indigo-600' : 'bg-amber-100 text-amber-600'}">
            ${isDoc ? '🖼️' : '🔗'}
          </div>
          <div class="truncate">
            <div class="flex items-center gap-1.5">
              <h4 class="font-bold text-slate-700 truncate">${record.title}</h4>
              <span class="text-[9px] bg-slate-200 text-slate-600 px-1.5 py-0.5 rounded-md font-semibold">${record.category || 'عام'}</span>
            </div>
            <p class="text-[10px] text-slate-400">${dateStr} • ${isDoc ? 'مستند صوري' : 'كود QR'}</p>
          </div>
        </div>

        <div class="flex items-center gap-1.5 shrink-0">
          <button onclick="openPreviewModal(${record.id})" class="bg-indigo-50 text-indigo-600 px-2.5 py-1.5 rounded-xl hover:bg-indigo-100 font-bold">👁️ فتح</button>
          <button onclick="deleteRecord(${record.id})" class="bg-rose-50 text-rose-600 p-1.5 rounded-xl hover:bg-rose-100">🗑️</button>
        </div>
      `;

      recordsContainer.appendChild(card);
    });
  } catch (e) {
    console.error(e);
  }
}

filterCategory?.addEventListener('change', renderRecordsList);

window.deleteRecord = async (id) => {
  await deleteRecordFromDB(STORE_DOCS, id);
  triggerVibration(40);
  renderRecordsList();
};

btnClearDB?.addEventListener('click', async () => {
  if (confirm('هل أنت متأكد من مسح جميع السجلات؟')) {
    await clearAllDB(STORE_DOCS);
    triggerVibration([50, 50, 50]);
    renderRecordsList();
    setStatus('تم مسح الأرشيف بالكامل.');
  }
});

// ==========================================
// 6. المعاينة، OCR، PDF، مشاركة وطباعة
// ==========================================
const modal = document.getElementById('preview-modal');
const modalTitle = document.getElementById('modal-title');
const modalContentBox = document.getElementById('modal-content-box');
const ocrTextarea = document.getElementById('ocr-result-text');

window.openPreviewModal = async (id) => {
  const records = await getAllRecordsFromDB(STORE_DOCS);
  currentModalRecord = records.find(r => r.id == id);
  if (!currentModalRecord) return;

  modalTitle.innerText = currentModalRecord.title + ` [${currentModalRecord.category || 'عام'}]`;
  modalContentBox.innerHTML = '';
  ocrTextarea.value = '';

  if (currentModalRecord.type === 'DOCUMENT') {
    modalContentBox.innerHTML = `
      <div class="rounded-2xl overflow-hidden border border-slate-200 bg-slate-900 flex justify-center max-h-72">
        <img src="${currentModalRecord.content}" class="object-contain max-h-72 w-auto" id="modal-img-target" />
      </div>
    `;
  } else {
    modalContentBox.innerHTML = `
      <div class="p-4 bg-amber-50 border border-amber-200 rounded-2xl text-slate-800 break-all text-xs font-mono">
        <p class="font-bold text-amber-700 mb-1">المحتوى الممسوح:</p>
        ${currentModalRecord.content}
      </div>
    `;
  }

  modal.classList.remove('hidden');
};

document.getElementById('btn-close-modal')?.addEventListener('click', () => {
  modal.classList.add('hidden');
  currentModalRecord = null;
});

// OCR
document.getElementById('btn-run-ocr')?.addEventListener('click', async () => {
  if (!currentModalRecord || currentModalRecord.type !== 'DOCUMENT') {
    ocrTextarea.value = 'الـ OCR متاح فقط لمستندات الصور.';
    return;
  }

  ocrTextarea.value = 'جاري تحليل النص باستخدام Tesseract...';

  try {
    const worker = await Tesseract.createWorker('ara+eng');
    const ret = await worker.recognize(currentModalRecord.content);
    ocrTextarea.value = ret.data.text || 'لم يتم العثور على نص واضح.';
    await worker.terminate();
  } catch (err) {
    ocrTextarea.value = 'حدث خطأ أثناء إجراء الـ OCR.';
  }
});

// PDF
document.getElementById('modal-btn-pdf')?.addEventListener('click', () => {
  if (!currentModalRecord) return;

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  doc.setFontSize(16);
  doc.text(currentModalRecord.title, 10, 15);

  if (currentModalRecord.type === 'DOCUMENT') {
    doc.addImage(currentModalRecord.content, 'JPEG', 10, 25, 190, 120);
    if (ocrTextarea.value) {
      doc.setFontSize(10);
      doc.text("OCR Text:", 10, 155);
      doc.text(ocrTextarea.value.substring(0, 300), 10, 165);
    }
  } else {
    doc.setFontSize(12);
    doc.text(`QR Result: ${currentModalRecord.content}`, 10, 35);
  }

  doc.save(`${currentModalRecord.title}.pdf`);
  setStatus('تم تحميل ملف الـ PDF بنجاح 📄');
});

// مشاركة
document.getElementById('modal-btn-share')?.addEventListener('click', async () => {
  if (!currentModalRecord) return;

  if (navigator.share) {
    try {
      await navigator.share({
        title: currentModalRecord.title,
        text: currentModalRecord.type === 'QR_CODE' ? currentModalRecord.content : ocrTextarea.value || 'مستند ممسوح',
      });
      setStatus('تمت المشاركة بنجاح 📲');
    } catch (e) {
      console.log('إلغاء المشاركة');
    }
  } else {
    alert('ميزة المشاركة غير مدعومة على هذا المتصفح.');
  }
});

// طباعة
document.getElementById('modal-btn-print')?.addEventListener('click', () => {
  if (!currentModalRecord) return;
  const printWindow = window.open('', '_blank');
  
  if (currentModalRecord.type === 'DOCUMENT') {
    printWindow.document.write(`<img src="${currentModalRecord.content}" style="max-width:100%" onload="window.print(); window.close();" />`);
  } else {
    printWindow.document.write(`<h2>${currentModalRecord.title}</h2><p>${currentModalRecord.content}</p>`);
    printWindow.print();
    printWindow.close();
  }
});

function triggerVibration(pattern) {
  if ('vibrate' in navigator) navigator.vibrate(pattern);
}

// ==========================================
// 7. تهيئة التطبيق عند اكتمال تحميل DOM
// ==========================================
async function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('sw.js');
    } catch (e) {
      console.error(e);
    }
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await initDB();
  await renderRecordsList();
  await registerServiceWorker();
  await initBatteryStatus(); // تشغيل حالة البطارية

  const btnRequestNotif = document.getElementById('btn-request-notif');
  if (btnRequestNotif) {
    btnRequestNotif.addEventListener('click', requestNotificationPermission);
  }

  const btnSyncNow = document.getElementById('btn-sync-now');
  if (btnSyncNow) {
    btnSyncNow.addEventListener('click', triggerBackgroundSync);
  }
});
