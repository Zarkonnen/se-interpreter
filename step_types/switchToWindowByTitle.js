exports.run = function(tr, cb) {
  tr.do('windowHandles', [], cb, function(err, handles) {
    var requiredTitle = tr.p('title');
    function tryHandle(handleIndex) {
      if (handleIndex >= handles.length) {
        cb({'success': false});
        return;
      }
      tr.do('window', [handles[handleIndex]], cb, function(err) {
        tr.do('title', [], cb, function(err, title) {
          if (requiredTitle == title) {
            cb({'success': true});
          } else {
            tryHandle(handleIndex + 1);
          }
        });
      });
    }
    tryHandle(0);
  });
};
