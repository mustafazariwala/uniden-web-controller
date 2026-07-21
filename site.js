function init() {
    if (!('serial' in navigator)) {
        const notSupported = document.querySelectorAll('.noserial');
        for (const element of notSupported) {
            element.classList.remove('hidden');
        }
        setStatus('Serial unsupported', 'error');
        return;
    }

    setStatus('Disconnected');
    clearLog('Ready.');
}

async function getSystemDetails(port, index) {
    let details = await port.send(`SIN,${index}`);
    return {
        type: details[0],
        name: details[1],
        quickKey: details[2],
        holdTime: details[3],
        lockout: details[4],
        reserved: details[5],
        delay: details[6],
        skip: details[7],
        emergencyAlert: details[8],
        revIndex: details[9],
        fwdIndex: details[10],
        channelGroupHead: details[11],
        channelGroupTail: details[12],
        sequence: details[13],
    }
}

function getLogArea() {
    return document.querySelector('#sessionLog');
}

function setStatus(text, state) {
    const status = document.querySelector('#connectionStatus');
    status.textContent = text;
    status.classList.toggle('active', state === 'active');
    status.classList.toggle('error', state === 'error');
}

function timestamp() {
    return new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
}

function appendLog(text, label = 'INFO') {
    const logArea = getLogArea();
    logArea.value += `[${timestamp()}] ${label.padEnd(7)} ${text}\r\n`;
    logArea.scrollTop = logArea.scrollHeight;
}

function resetLog(text) {
    const logArea = getLogArea();
    logArea.value = '';
    appendLog(text);
}

async function copyLog() {
    const logArea = getLogArea();

    try {
        await navigator.clipboard.writeText(logArea.value);
        appendLog('Session log copied to clipboard.');
    }
    catch (error) {
        appendLog(`Clipboard copy failed: ${error.message}`, 'ERROR');
    }
}

function downloadLog() {
    const logArea = getLogArea();
    const blob = new Blob([logArea.value], { type: 'text/plain' });
    const link = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    link.href = URL.createObjectURL(blob);
    link.download = `uniden-session-${stamp}.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

function clearLog(message = 'Log cleared.') {
    const logArea = getLogArea();
    logArea.value = '';
    appendLog(message);
}

function addOperatorNote() {
    const noteArea = document.querySelector('#operatorNote');
    const note = noteArea.value.trim();

    if (note.length === 0) {
        return;
    }

    for (const line of note.split(/\r?\n/)) {
        appendLog(line, 'COMMENT');
    }

    noteArea.value = '';
    noteArea.focus();
}

function timeout(ms) {
    return new Promise((resolve, reject) => {
        let id = setTimeout(() => {
            clearTimeout(id);
            reject(new Error(`Timed out in ${ms}ms.`));
        }, ms);
    });
}

async function autoDetectBaudRate() {
    resetLog('Automatically detecting baud rate...');
    setStatus('Detecting', 'active');

    const bauds = Array.from(document.querySelectorAll('form select[name=baud] option')).reverse().map(e => parseInt(e.value, 10));

    let serialPort;
    try {
        serialPort = await navigator.serial.requestPort();
    }
    catch (e) {
        appendLog(`Failed: ${e.message}`, 'ERROR');
        setStatus('Disconnected', 'error');
        return;
    }

    for (const baud of bauds) {
        appendLog(`Trying baud rate ${baud}...`);

        let port;
        try {
            port = await serial_connectPort(serialPort, baud);
            await port.write('MDL');
            let response = await Promise.race([ port.read(), timeout(500) ]);
            while (response[0] === 'ERR') {
                // We can get error responses due to previous commands we sent at the wrong baud rate.
                // If we can identify this, just try again.

                await port.write('MDL');
                response = await Promise.race([ port.read(), timeout(500) ]);
            }

            if (response[0] !== 'MDL') {
                appendLog('Got garbage response. Ignoring...');
                continue;
            }
            
            appendLog(`Auto-detected baud rate: ${baud}.`);
            appendLog(`Found device: ${response[1]}`);
            document.querySelector('select[name=baud]').value = baud;
            setStatus(`Detected ${baud}`, 'active');
            return;
        }
        catch {
        }
        finally  {
            if (port) {
                try {
                    await port.close();
                }
                catch {
                }
            }
        }
    }

    appendLog('Could not find any suitable baud rate.', 'ERROR');
    setStatus('Detection failed', 'error');
}

async function connect() {
    resetLog('Connecting...');
    setStatus('Connecting', 'active');

    let serialPort;    
    try {
        serialPort = await navigator.serial.requestPort();
    }
    catch (e) {
        appendLog(`Failed: ${e.message}`, 'ERROR');
        setStatus('Disconnected', 'error');
        return;
    }

    const baud = parseInt(document.querySelector('select[name=baud]').value, 10);
    let port;

    try {
        port = await serial_connectPort(serialPort, baud);
        let response = await Promise.race([ port.send('MDL'), timeout(5000) ]);
        
        appendLog(`Model: ${response[0]}`);
        
        response = await port.send('PRG');
        if (response[0] != 'OK') {
            appendLog(`Failed to enter programming mode: ${response[0]}`, 'ERROR');
            setStatus('Programming failed', 'error');
            return;
        }

        appendLog('Entered programming mode.');
        setStatus('Programming', 'active');

        response = await port.send('MEM');
        appendLog(`Memory used: ${response[0]}%`);

        response = await port.send('SCT');
        const numSystems = parseInt(response[0], 10);
        appendLog(`${numSystems} systems detected.`);

        if (numSystems > 0) {
            const head = await port.send('SIH');

            let currentSystemIndex = parseInt(head[0], 10);
            while (currentSystemIndex > 0) {
                let systemDetails = await getSystemDetails(port, currentSystemIndex);
                appendLog(`Found system: ${systemDetails.name}`);

                let nextIndex = await port.send(`FWD,${currentSystemIndex}`);
                currentSystemIndex = parseInt(nextIndex[0], 10);
            }
        }

        response = await port.send('EPG');
        if (response[0] != 'OK') {
            appendLog(`Failed to exit programming mode: ${response[0]}`, 'ERROR');
            setStatus('Disconnect error', 'error');
            return;
        }
        appendLog('Exited programming mode.');
        setStatus('Disconnected');
    }
    catch (error) {
        appendLog(`Unhandled error: ${error.message}`, 'ERROR');
        appendLog('Disconnecting...');
        setStatus('Error', 'error');
    }
    finally {
        if (port) {
            try {
                await port.close();
            }
            catch {
            }

            appendLog('Disconnected.');
        }
    }
}

document.addEventListener("DOMContentLoaded", function(event) {
    init();
});
