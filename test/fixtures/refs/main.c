#include "api.h"

int bar(void)
{
    helper();
    int a = foo(1);
    int b = foo(2);
    return a + b;
}

int baz(void)
{
    /* foo() must not count in comments */
    const char *msg = "foo() must not count in strings";
    printf("%s", msg);
    MAX(1, 2);
    return 0;
}
