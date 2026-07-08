/* LRT Maintenance Dashboard — Client-side interactions */

function togglePassword(fieldId) {
    const input = document.getElementById(fieldId);
    const btn = input.parentElement.querySelector('.toggle-password');
    if (input.type === 'password') {
        input.type = 'text';
        btn.textContent = 'Hide';
    } else {
        input.type = 'password';
        btn.textContent = 'Show';
    }
}

function closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.hidden = true;
}

function openModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.hidden = false;
}

async function fetchTrain(trainId) {
    const res = await fetch(`/api/trains/${trainId}`);
    return res.json();
}

async function openEditModal(trainId) {
    const train = await fetchTrain(trainId);
    document.getElementById('editTrainId').value = trainId;
    document.getElementById('editMileage').value = train.current_mileage;
    document.getElementById('editServiceability').value = train.serviceability_status;
    document.getElementById('editReason').value = '';
    openModal('editModal');
}

async function openMaintenanceModal(trainId) {
    const train = await fetchTrain(trainId);
    document.getElementById('maintTrainId').value = trainId;
    document.getElementById('maintRemarks').value = '';
    document.getElementById('maintenanceConfirmText').textContent =
        `Mark the ${train.next_pm_milestone.toLocaleString()} km PM milestone as completed for ${trainId}? ` +
        `Current mileage: ${train.current_mileage.toLocaleString()} km. ` +
        `Next PM will advance to the following milestone.`;
    openModal('maintenanceModal');
}

async function submitEdit(e) {
    e.preventDefault();
    const trainId = document.getElementById('editTrainId').value;
    const mileage = document.getElementById('editMileage').value;
    const serviceability = document.getElementById('editServiceability').value;
    const reason = document.getElementById('editReason').value;

    if (!reason.trim()) {
        alert('Please provide a reason for this edit.');
        return;
    }

    const mileageRes = await fetch('/api/manual-edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ train_id: trainId, field: 'current_mileage', new_value: mileage, reason }),
    });
    const mileageData = await mileageRes.json();

    if (!mileageData.success) {
        alert(mileageData.message);
        return;
    }

    await fetch('/api/manual-edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ train_id: trainId, field: 'serviceability_status', new_value: serviceability, reason }),
    });

    closeModal('editModal');
    location.reload();
}

async function submitMaintenance(e) {
    e.preventDefault();
    const trainId = document.getElementById('maintTrainId').value;
    const remarks = document.getElementById('maintRemarks').value;

    const res = await fetch('/api/maintenance-completed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ train_id: trainId, remarks }),
    });
    const data = await res.json();

    if (data.success) {
        closeModal('maintenanceModal');
        location.reload();
    } else {
        alert(data.message);
    }
}

function confirmReview(trainId) {
    showConfirm(
        'Confirm Manual Review',
        `Clear the manual review flag for ${trainId}? This confirms the scan data has been verified.`,
        async () => {
            const res = await fetch('/api/manual-edit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    train_id: trainId,
                    field: 'needs_manual_review',
                    new_value: false,
                    reason: 'Manual review confirmed by operator',
                }),
            });
            const data = await res.json();
            if (data.success) location.reload();
            else alert(data.message);
        }
    );
}

function flagReview(trainId) {
    showConfirm(
        'Flag for Manual Review',
        `Flag ${trainId} for manual review? This will mark the scan as needing verification.`,
        async () => {
            const res = await fetch('/api/manual-edit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    train_id: trainId,
                    field: 'needs_manual_review',
                    new_value: true,
                    reason: 'Flagged for manual review by operator',
                }),
            });
            const data = await res.json();
            if (data.success) location.reload();
            else alert(data.message);
        }
    );
}

function viewHistory(trainId) {
    window.location.href = `/maintenance-history?train_id=${trainId}`;
}

function showConfirm(title, message, onConfirm) {
    const modal = document.getElementById('confirmModal');
    if (!modal) {
        if (confirm(message)) onConfirm();
        return;
    }
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmMessage').textContent = message;
    const btn = document.getElementById('confirmBtn');
    btn.onclick = () => {
        closeModal('confirmModal');
        onConfirm();
    };
    openModal('confirmModal');
}

document.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay') && !e.target.hidden) {
        e.target.hidden = true;
    }
});

const registerForm = document.getElementById('registerForm');
if (registerForm) {
    registerForm.addEventListener('submit', (e) => {
        const pw = document.getElementById('password').value;
        const cpw = document.getElementById('confirm_password').value;
        if (pw !== cpw) {
            e.preventDefault();
            alert('Passwords do not match.');
        }
    });
}

let refreshInterval;
let lastScanTimestamp = document.getElementById('liveTime')?.textContent?.trim() || '';

async function pollDashboard() {
    try {
        const res = await fetch('/api/dashboard-data');
        if (!res.ok) return;
        const data = await res.json();

        if (data.kpis) {
            const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
            set('kpiTotal', data.kpis.total);
            set('kpiOverdue', data.kpis.overdue);
            set('kpiDueSoon', data.kpis.due_soon);
            set('kpiOk', data.kpis.ok);
            set('kpiReview', data.kpis.review);
        }

        if (data.latest_scan) {
            const scan = data.latest_scan;
            const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
            set('liveTrain', scan.train_id);
            set('liveMileage', Number(scan.scanned_mileage).toLocaleString() + ' km');
            set('liveResult', scan.result);
            set('liveTime', scan.timestamp);
            set('liveReason', scan.reason);

            if (scan.timestamp && scan.timestamp !== lastScanTimestamp) {
                if (lastScanTimestamp) {
                    location.reload();
                }
                lastScanTimestamp = scan.timestamp;
            }
        }
    } catch (e) {
        console.error('Dashboard poll failed:', e);
    }
}

function startAutoRefresh() {
    const el = document.getElementById('lastRefresh');
    if (!el) return;

    let seconds = 5;
    pollDashboard();
    refreshInterval = setInterval(() => {
        seconds--;
        if (seconds <= 0) {
            seconds = 5;
            pollDashboard();
        }
        el.textContent = `Auto refresh: ${seconds} sec`;
    }, 1000);
}

if (document.getElementById('trainGrid')) {
    startAutoRefresh();
}
