exports.run = function(tr, cb) {
    tr.do('moveTo', [null, tr.p('x'), tr.p('y')], cb);
};

