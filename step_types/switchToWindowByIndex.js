exports.run = function(tr, cb) {
  tr.do('windowHandles', [], cb, function(err, handles) {
    tr.do('window', [handles[parseInt(tr.p('index'))]], cb);
  });
};
