/** GPS starts only on demand. No permission request is made by constructing this. */
(function (root) {
  'use strict';
  function createGps(geo, onChange, clock = () => Date.now()) {
    let position = null, watchId = null, generation = 0, message = 'GPSは停止中です';
    let receiveFix = null, rejectFix = null;
    const waiters = new Set();
    const fresh = () => position && clock() - position.updated_at <= 15000 && clock() >= position.updated_at - 1000;
    function emit() { onChange({ position, running: watchId !== null, message, fresh: !!fresh() }); }
    function settle(error) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        if (error) waiter.reject(error); else waiter.resolve({ ...position });
      }
      waiters.clear();
    }
    function stop(reason = 'GPSは停止中です') {
      generation++;
      if (watchId !== null && geo) geo.clearWatch(watchId);
      watchId = null;
      position = null;
      message = reason;
      settle(new Error(reason));
      emit();
    }
    function start() {
      if (watchId !== null) return;
      if (!geo) { message = 'この端末では位置情報が利用できません'; emit(); settle(new Error(message)); return; }
      const token = ++generation;
      message = 'GPS取得中…';
      // Reserve before calling the API, including synchronous mocks/errors.
      watchId = -1;
      emit();
      try {
        receiveFix = pos => {
          if (token !== generation) return;
          const c = pos.coords;
          if (!Number.isFinite(c.latitude) || !Number.isFinite(c.longitude) ||
              Math.abs(c.latitude) > 90 || Math.abs(c.longitude) > 180) return;
          position = {
            lat: c.latitude, lon: c.longitude, accuracy_m: c.accuracy,
            altitude: c.altitude, altitude_accuracy_m: c.altitudeAccuracy,
            updated_at: Number.isFinite(pos.timestamp) ? pos.timestamp : clock(),
          };
          message = fresh() ? 'GPS取得中' : '古い位置情報です。更新を待っています';
          emit();
          if (fresh()) settle();
        };
        rejectFix = err => {
          if (token !== generation) return;
          const messages = { 1: '位置情報が許可されていません。iPhoneの設定を確認してください',
            2: '位置を取得できません。空の見える場所で再度お試しください',
            3: '位置の取得がタイムアウトしました。再度お試しください' };
          stop(messages[err.code] || '位置を取得できませんでした');
        };
        const id = geo.watchPosition(receiveFix, rejectFix, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
        if (token === generation) watchId = id; else geo.clearWatch(id);
      } catch (error) { stop(error.message || '位置情報を開始できませんでした'); }
    }
    function getFresh() {
      if (fresh() && watchId !== null) return Promise.resolve({ ...position });
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error('新しい位置を取得できませんでした。もう一度記録してください'));
        }, 25000);
        waiters.add(waiter);
        const alreadyRunning = watchId !== null;
        start();
        // A stationary watch may not emit again. Ask for a fresh fix on this explicit record action.
        if (alreadyRunning && geo && typeof geo.getCurrentPosition === 'function') {
          try { geo.getCurrentPosition(receiveFix, rejectFix, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }); }
          catch (error) { stop(error.message || '位置情報を更新できませんでした'); }
        }
      });
    }
    return { start, stop, getFresh, refresh: emit, isRunning: () => watchId !== null };
  }
  root.CollectorGps = { create: createGps };
})(typeof self !== 'undefined' ? self : this);
